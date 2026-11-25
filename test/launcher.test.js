import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readPanelFile } from '../src/assets.js';
import { isOurInstance } from '../src/launcher.js';
import { createHttp } from '../src/panel/server.js';
import { createService } from '../src/server.js';

test('panel assets are read from the checkout outside a single executable', async () => {
  assert.match((await readPanelFile('index.html')).toString('utf8'), /Agents-MCP/);
  assert.match((await readPanelFile('panel.css')).toString('utf8'), /--dsw-alias|:root/);
  await assert.rejects(readPanelFile('missing.css'), { code: 'ENOENT' });
});

test('instance detection tells a panel apart from a foreign listener', async t => {
  const foreign = createServer((req, res) => res.end('not ours')).listen(0, '127.0.0.1');
  await new Promise(resolve => foreign.once('listening', resolve));
  t.after(() => foreign.close());
  assert.equal(await isOurInstance(foreign.address().port), false);
  // Nothing listening at all is not an instance either.
  const closed = createServer(() => {}).listen(0, '127.0.0.1');
  await new Promise(resolve => closed.once('listening', resolve));
  const free = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  assert.equal(await isOurInstance(free), false);
});

test('a running panel is recognised as this instance', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-mcp-launch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const service = await createService({ stateDir: dir, env: { ...process.env, AGENTS_MCP_FIXTURES: '1' } });
  const http = await createHttp(service, { port: 0 });
  t.after(async () => {
    http.close();
    await service.close();
  });
  assert.equal(await isOurInstance(http.address().port), true);
});
