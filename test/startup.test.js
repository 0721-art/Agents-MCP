// What the panel shows before the first probe finishes: a cached catalog, and a state
// directory that works even when the default one cannot be written.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createStore, resolveStateDirectory } from '../src/engine/store.js';
import { createRegistry } from '../src/registry/index.js';

test('the agent list answers from the cached catalog before probing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-mcp-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cached = [{ id: 'cached-agent', name: 'Cached', available: true, models: [], warnings: [],
    probedAt: new Date().toISOString() }];
  await writeFile(join(dir, 'agents-cache.json'), JSON.stringify(cached) + '\n');
  const store = await createStore(dir, process.env);
  const registry = createRegistry({
    store, config: () => ({ agents: {}, fixtures: false }),
    env: { ...process.env, AGENTS_MCP_FIXTURES: '1' },
  });
  const first = await registry.list();
  assert.equal(first[0].id, 'cached-agent');
  assert.equal(registry.probing(), false, 'a fresh cache must not stall the first paint');
});

test('a state directory that cannot be written is named, and an explicit one is refused', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-mcp-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A file where the directory should be makes mkdir fail the way a denied folder does.
  const blocked = join(dir, 'blocked');
  await writeFile(blocked, 'not a directory');
  await assert.rejects(resolveStateDirectory({ dir: blocked, env: process.env }),
    error => error.code === 'E_STATE_READONLY' && error.message.includes(blocked));
});

test('an unwritable default falls back to a writable local directory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-mcp-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appData = join(dir, 'roaming');
  await writeFile(appData, 'not a directory');
  const local = join(dir, 'local');
  await mkdir(local);
  const resolved = await resolveStateDirectory({
    dir: undefined, env: { USERPROFILE: dir, APPDATA: appData, LOCALAPPDATA: local },
  });
  assert.equal(resolved.dir, join(local, 'Agents-MCP'));
  assert.equal(resolved.fallback.from, join(appData, 'Agents-MCP'));
  assert.ok(resolved.fallback.reason);
});
