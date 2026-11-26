// The update banner must never lie about the version, and a failed check must leave the
// panel working. Both are pinned here with a stubbed fetch, so no test touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import {
  applyUpdate, checkForUpdate, cleanupInstall, installPending, isNewer, parseVersion, replaceExecutable,
  replaceExecutables, version,
} from '../src/update.js';

test('versions compare the way a user would expect', () => {
  assert.deepEqual(parseVersion('v0.1.10'), [0, 1, 10]);
  assert.deepEqual(parseVersion('0.1'), null);
  assert.equal(isNewer('0.1.1', '0.1.0'), true);
  assert.equal(isNewer('v0.2.0', '0.1.9'), true);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
  assert.equal(isNewer('0.0.9', '0.1.0'), false);
  assert.equal(isNewer('nightly', '0.1.0'), false);
  assert.match(version, /^\d+\.\d+\.\d+/);
});

const release = latest => ({
  ok: true,
  json: async () => ({ tag_name: latest, html_url: 'https://example.test/rel', published_at: '2026-11-25T00:00:00Z', body: 'notes' }),
});

const temp = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-mcp-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('a newer release is reported and cached for the next load', async t => {
  const stateDir = await temp(t);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return release('v9.9.9'); };

  const first = await checkForUpdate({ stateDir, current: '0.1.0', fetchImpl, env: {} });
  assert.equal(first.latest, 'v9.9.9');
  assert.equal(first.newer, true);
  assert.equal(first.url, 'https://example.test/rel');
  assert.equal(first.notes, 'notes');

  const second = await checkForUpdate({ stateDir, current: '0.1.0', fetchImpl, env: {} });
  assert.equal(second.newer, true);
  assert.equal(calls, 1, 'a warm cache must not call GitHub again');

  const renewed = await checkForUpdate({ stateDir, current: '0.1.0', fetchImpl, env: {}, fresh: true });
  assert.equal(renewed.newer, true);
  assert.equal(calls, 2, 'the 检查更新 button bypasses the cache');

  assert.match(await readFile(join(stateDir, 'update-check.json'), 'utf8'), /9\.9\.9/);
});

test('a release older than the running build is not offered', async t => {
  const stateDir = await temp(t);
  const info = await checkForUpdate({ stateDir, current: '0.2.0', env: {}, fetchImpl: async () => release('v0.1.9') });
  assert.equal(info.newer, false);
  assert.equal(info.latest, 'v0.1.9');
});

test('a failed check keeps the panel usable and says why', async t => {
  const stateDir = await temp(t);
  const offline = async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); };
  const info = await checkForUpdate({ stateDir, current: '0.1.0', env: {}, fetchImpl: offline });
  assert.equal(info.newer, false);
  assert.match(info.error, /ENOTFOUND/);

  const rateLimited = await checkForUpdate({ stateDir, current: '0.1.0', env: {}, fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.match(rateLimited.error, /403/);
});

test('the check can be switched off', async t => {
  const stateDir = await temp(t);
  let calls = 0;
  const info = await checkForUpdate({
    stateDir, current: '0.1.0', env: { AGENTS_MCP_NO_UPDATE_CHECK: '1' }, fetchImpl: async () => { calls += 1; return release('v9.9.9'); },
  });
  assert.equal(info.disabled, true);
  assert.equal(info.newer, false);
  assert.equal(calls, 0);
});

test('only a git checkout may update itself', async t => {
  const root = await temp(t);
  await assert.rejects(applyUpdate({ root, env: {} }), error => error.code === 'E_NOT_CHECKOUT' && /git checkout/.test(error.message));
});

// The packaged exe replaces its own file: download beside it, rename the running image out
// of the way, put the new one in place. A checksum mismatch must never be installed.
async function selfUpdateFixture(t, { bytes = 'new binary', digest } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agents-mcp-swap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'Agents-MCP.exe');
  await writeFile(target, 'old binary');
  const size = Buffer.byteLength(bytes);
  const asset = { name: 'Agents-MCP.exe', url: 'https://example.test/Agents-MCP.exe', size,
    digest: digest ?? 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
  await writeFile(join(dir, 'update-check.json'), JSON.stringify({ latest: 'v0.2.0', assets: { service: asset } }) + '\n');
  const fetchImpl = async () => ({ ok: true, status: 200, body: Readable.toWeb(Readable.from([Buffer.from(bytes)])) });
  return { dir, target, fetchImpl };
}

test('a packaged update downloads, checks and swaps in the new binary', async t => {
  const { dir, target, fetchImpl } = await selfUpdateFixture(t);
  const result = await replaceExecutable({ stateDir: dir, target, fetchImpl });
  assert.equal(result.restarting, true);
  assert.equal(result.version, 'v0.2.0');
  assert.equal(await readFile(target, 'utf8'), 'new binary');
  assert.equal(await readFile(target + '.old', 'utf8'), 'old binary');
});

test('a download that fails its checksum is thrown away', async t => {
  const { dir, target, fetchImpl } = await selfUpdateFixture(t, { digest: 'sha256:' + '0'.repeat(64) });
  await assert.rejects(replaceExecutable({ stateDir: dir, target, fetchImpl }), error => error.code === 'E_DOWNLOAD');
  assert.equal(await readFile(target, 'utf8'), 'old binary');
});

test('a release without an executable asset is refused instead of half-applied', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-mcp-swap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'Agents-MCP.exe');
  await writeFile(target, 'old binary');
  await writeFile(join(dir, 'update-check.json'), JSON.stringify({ latest: 'v0.2.0', assets: { service: null } }) + '\n');
  await assert.rejects(replaceExecutable({ stateDir: dir, target, fetchImpl: async () => { throw new Error('no network'); } }),
    error => error.code === 'E_NO_ASSET');
  assert.equal(await readFile(target, 'utf8'), 'old binary');
});

test('both executables are replaced in one update, and the window owns the restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-mcp-swap-two-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const servicePath = join(dir, 'Agents-MCP.exe');
  const panelPath = join(dir, 'Agents-MCP.Panel.exe');
  await writeFile(servicePath, 'old service');
  await writeFile(panelPath, 'old panel');
  const files = { 'Agents-MCP.exe': 'new service', 'Agents-MCP.Panel.exe': 'new panel' };
  const asset = name => ({ name, url: 'https://example.test/' + name, size: Buffer.byteLength(files[name]),
    digest: 'sha256:' + createHash('sha256').update(files[name]).digest('hex') });
  await writeFile(join(dir, 'update-check.json'), JSON.stringify({
    latest: 'v0.2.0',
    assets: { service: asset('Agents-MCP.exe'), panel: asset('Agents-MCP.Panel.exe') },
  }) + '\n');
  const fetchImpl = async url => ({ ok: true, status: 200,
    body: Readable.toWeb(Readable.from([Buffer.from(files[url.split('/').pop()])])) });
  const result = await replaceExecutables({ stateDir: dir, fetchImpl,
    targets: [{ role: 'panel', path: panelPath }, { role: 'service', path: servicePath }] });
  assert.equal(result.restart, 'panel');
  assert.equal(result.files.length, 2);
  assert.equal(await readFile(servicePath, 'utf8'), 'new service');
  assert.equal(await readFile(panelPath, 'utf8'), 'new panel');
  assert.equal(await readFile(servicePath + '.old', 'utf8'), 'old service');
});

test('a release that ships only the service updates the service and leaves the window alone', async t => {
  const { dir, target, fetchImpl } = await selfUpdateFixture(t);
  const result = await replaceExecutables({ stateDir: dir, fetchImpl, targets: [{ role: 'service', path: target }] });
  assert.equal(result.restart, 'launcher');
  assert.equal(await readFile(target, 'utf8'), 'new binary');
});

test('a swap refused by the folder is retried on the next launch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-mcp-pending-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'Agents-MCP.exe');
  await writeFile(target, 'old binary');
  await writeFile(target + '.new', 'new binary');
  assert.equal(installPending({ target }), true);
  assert.equal(await readFile(target, 'utf8'), 'new binary');
  cleanupInstall({ target });
  assert.equal(installPending({ target }), false);
});
