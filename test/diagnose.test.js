// The self-check must report facts, not hopes: every field is probed when asked.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { environmentReport } from '../src/diagnose.js';

async function fakeHome() {
  const root = await mkdtemp(join(tmpdir(), 'amcp-home-'));
  const env = {
    USERPROFILE: root,
    APPDATA: join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(root, 'AppData', 'Local'),
  };
  await mkdir(join(root, 'Desktop'), { recursive: true });
  await mkdir(join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), { recursive: true });
  return { root, env };
}

test('a writable state directory and the shortcut folders are reported writable', async () => {
  const { root, env } = await fakeHome();
  const stateDir = join(root, 'state');
  const report = await environmentReport({ env, stateDir });
  assert.equal(report.state.dir, stateDir);
  assert.equal(report.state.writable, true);
  assert.deepEqual(report.locations.map(location => location.kind), ['desktop', 'programs']);
  assert.ok(report.locations.every(location => location.writable));
  assert.equal(report.update.proxy, '');
  assert.equal(report.update.source, 'direct');
  assert.equal(report.update.reachable, null);
});

test('an unwritable state directory says why', async () => {
  const { root, env } = await fakeHome();
  const blocker = join(root, 'not-a-dir');
  await writeFile(blocker, 'x');
  const report = await environmentReport({ env, stateDir: blocker });
  assert.equal(report.state.writable, false);
  assert.ok(report.state.reason, 'a reason is given');
});

test('the proxy source is named and its port is probed', async t => {
  const { root, env } = await fakeHome();
  const server = createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = '127.0.0.1:' + server.address().port;

  const fromConfig = await environmentReport({ env, stateDir: join(root, 's1'), proxy: address });
  assert.equal(fromConfig.update.source, 'config');
  assert.equal(fromConfig.update.reachable, true);

  const fromEnv = await environmentReport({ env: { ...env, HTTPS_PROXY: 'http://' + address }, stateDir: join(root, 's2') });
  assert.equal(fromEnv.update.source, 'HTTPS_PROXY');
  assert.equal(fromEnv.update.reachable, true);

  const dead = await environmentReport({ env, stateDir: join(root, 's3'), proxy: '127.0.0.1:1', timeoutMs: 500 });
  assert.equal(dead.update.reachable, false);
});
