// The update banner must never lie about the version, and a failed check must leave the
// panel working. Both are pinned here with a stubbed fetch, so no test touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyUpdate, checkForUpdate, isNewer, parseVersion, version } from '../src/update.js';

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
  assert.throws(() => applyUpdate({ root, env: {} }), error => error.code === 'E_NOT_CHECKOUT' && /git checkout/.test(error.message));
});
