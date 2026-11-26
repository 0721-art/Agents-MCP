// Each client row answers "did it really connect", not just "is it in a config file".
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clientBridges, createUsage, readHistory, setBridge, usageId } from '../src/bridges.js';

async function home() {
  const root = await mkdtemp(join(tmpdir(), 'amcp-bridges-'));
  return { root, env: { USERPROFILE: root } };
}

test('nothing installed is reported as nothing installed', async () => {
  const { env } = await home();
  const rows = await clientBridges({ env });
  assert.deepEqual(rows.map(row => row.id), ['codex', 'claude', 'dsh']);
  assert.ok(rows.every(row => row.configured === false));
});

test('a codex table is found, and enabled = false is honoured', async () => {
  const { root, env } = await home();
  await mkdir(join(root, '.codex'), { recursive: true });
  const config = join(root, '.codex', 'config.toml');
  await writeFile(config, [
    '[mcp_servers.agents-mcp]',
    'default_tools_approval_mode = "approve"',
    'command = \'node\'',
    '',
    '[mcp_servers.other]',
    'enabled = false',
  ].join('\n'));
  let row = (await clientBridges({ env })).find(entry => entry.id === 'codex');
  assert.equal(row.configured, true);
  assert.equal(row.enabled, true);
  assert.match(row.detail, /免确认/);

  await writeFile(config, '[mcp_servers.agents-mcp]\nenabled = false\n');
  row = (await clientBridges({ env })).find(entry => entry.id === 'codex');
  assert.equal(row.enabled, false);
  assert.match(row.detail, /enabled = false/);
});

test('claude code is read from the user config', async () => {
  const { root, env } = await home();
  await writeFile(join(root, '.claude.json'), JSON.stringify({ mcpServers: { 'agents-mcp': { command: 'node' } } }));
  const row = (await clientBridges({ env })).find(entry => entry.id === 'claude');
  assert.equal(row.configured, true);
  assert.match(row.detail, /stdio/);
});

test('dsh is found through the bundle list, not only through the patch', async () => {
  const { root, env } = await home();
  const profile = join(root, '.dsh', 'profiles', 'desktop');
  await mkdir(join(profile, 'node_modules', 'dsh-agents-mcp'), { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-base', 'dsh-agents-mcp'] } } }));
  await writeFile(join(profile, 'node_modules', 'dsh-agents-mcp', 'cordis.patch.yml'),
    '- insert:\n    - id: agents-mcp-bridge\n      config:\n        serverName: agents-mcp\n');
  const row = (await clientBridges({ env })).find(entry => entry.id === 'dsh');
  assert.equal(row.configured, true);
  assert.match(row.detail, /desktop/);
});

test('client names map to the rows people expect', () => {
  assert.equal(usageId('codex-mcp-client'), 'codex');
  assert.equal(usageId('claude-code'), 'claude');
  assert.equal(usageId('DeepSeek Harness'), 'dsh');
  assert.equal(usageId('something-else'), 'other');
  assert.equal(usageId(undefined), 'other');
});

test('a call is remembered across restarts', async () => {
  const { root } = await home();
  const writes = [];
  const usage = createUsage(root, { writeFile: (path, body) => { writes.push(path); return writeFile(path, body); } });
  assert.equal(readHistory(root) instanceof Promise, true);
  await usage.note({ name: 'codex-cli', version: '1.0' });
  await usage.noteCall();
  const saved = await readHistory(root);
  assert.equal(saved.codex.name, 'codex-cli');
  assert.equal(saved.codex.calls, 1);
  assert.ok(writes.length >= 1);

  const again = createUsage(root);
  await again.load();
  assert.equal(again.snapshot().codex.calls, 1);
});

test('turning codex off writes enabled = false and turning it back on removes the line', async () => {
  const { root, env } = await home();
  await mkdir(join(root, '.codex'), { recursive: true });
  const config = join(root, '.codex', 'config.toml');
  const before = [
    'model = "gpt-6.2-sol"',
    '',
    '[mcp_servers.agents-mcp]',
    'default_tools_approval_mode = "approve"',
    "command = 'node'",
    '',
    '[mcp_servers.other]',
    'enabled = false',
  ].join('\n');
  await writeFile(config, before);

  await setBridge({ id: 'codex', enabled: false, env });
  let after = await readFile(config, 'utf8');
  assert.match(after, /\[mcp_servers\.agents-mcp\]\ndefault_tools_approval_mode = "approve"/);
  assert.match(after, /\nenabled = false\n/);
  assert.equal((after.match(/enabled = false/g) ?? []).length, 2, 'the other table keeps its own line');
  assert.equal((await clientBridges({ env })).find(row => row.id === 'codex').enabled, false);

  await setBridge({ id: 'codex', enabled: true, env });
  after = await readFile(config, 'utf8');
  assert.match(after, /\[mcp_servers\.agents-mcp\]\ndefault_tools_approval_mode = "approve"/);
  assert.equal((after.match(/enabled = false/g) ?? []).length, 1, 'only the unrelated table is still disabled');
  assert.equal((await clientBridges({ env })).find(row => row.id === 'codex').enabled, true);
});

test('a client that was never configured cannot be switched off', async () => {
  const { env } = await home();
  await assert.rejects(setBridge({ id: 'codex', enabled: false, env }), error => error.code === 'E_NOT_CONFIGURED');
  await assert.rejects(setBridge({ id: 'dsh', enabled: false, env }), error => error.code === 'E_NOT_CONFIGURED');
  await assert.rejects(setBridge({ id: 'cursor', enabled: false, env }), error => error.code === 'E_UNKNOWN_CLIENT');
});

test('claude code is switched by removing its server and putting it back', async () => {
  const { root, env } = await home();
  const stateDir = join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  const config = join(root, '.claude.json');
  const entry = { type: 'stdio', command: 'node', args: ['agents-mcp.js', '--mcp=stdio'] };
  await writeFile(config, JSON.stringify({ numStartups: 3, mcpServers: { 'agents-mcp': entry } }));

  await setBridge({ id: 'claude', enabled: false, env, stateDir });
  const off = JSON.parse(await readFile(config, 'utf8'));
  assert.equal(off.mcpServers['agents-mcp'], undefined);
  assert.equal(off.numStartups, 3, 'the rest of the file survives');
  assert.equal((await clientBridges({ env })).find(row => row.id === 'claude').configured, false);

  await setBridge({ id: 'claude', enabled: true, env, stateDir });
  const on = JSON.parse(await readFile(config, 'utf8'));
  assert.deepEqual(on.mcpServers['agents-mcp'], entry);
  assert.equal((await clientBridges({ env })).find(row => row.id === 'claude').configured, true);
});

test('the dsh bundle row gains disabled: true and loses it again', async () => {
  const { root, env } = await home();
  const profile = join(root, '.dsh', 'profiles', 'desktop');
  const bundle = join(profile, 'node_modules', 'dsh-agents-mcp');
  await mkdir(bundle, { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-agents-mcp'] } } }));
  const patch = join(bundle, 'cordis.patch.yml');
  const before = [
    '- insert:',
    '    - id: agents-mcp-bridge',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: agents-mcp',
    '    - id: something-else',
    '      name: "@deepseek-ai/other"',
    '',
  ].join('\n');
  await writeFile(patch, before);

  await setBridge({ id: 'dsh', enabled: false, env });
  let after = await readFile(patch, 'utf8');
  assert.match(after, /- id: agents-mcp-bridge\n(?:.*\n)*? {6}disabled: true\n {4}- id: something-else/);
  assert.match(after, /\n {4}- id: something-else/, 'the next row is untouched');
  assert.equal((await clientBridges({ env })).find(row => row.id === 'dsh').enabled, false);

  await setBridge({ id: 'dsh', enabled: true, env });
  after = await readFile(patch, 'utf8');
  assert.doesNotMatch(after, /disabled: true/);
  assert.equal((await clientBridges({ env })).find(row => row.id === 'dsh').enabled, true);
});
