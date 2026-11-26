// Each client row answers "did it really connect", not just "is it in a config file".
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clientBridges, createUsage, readHistory, usageId } from '../src/bridges.js';

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
