import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePresets, readPresets, savePreset, slug } from '../src/presets.js';
import { validateFlow } from '../src/engine/flow.js';

// Presets are user data, so these tests use a throwaway flow and a memory store instead
// of shipping any preset content of their own.
const flow = () => ({
  task: 'Do the thing.',
  participants: [{ id: 'p-1', agent: 'fixture', model: 'fixture-model', effort: 'low', role: 'Worker' }],
  steps: [{ id: 's-1', participant: 'p-1', task: 'Do it.', dependsOn: [], inputs: [], produces: ['result'] }],
  loops: [],
});

function memoryStore() {
  let data;
  return {
    dir: 'memory',
    readJson: async (path, fallback) => (data === undefined ? fallback : data),
    writeJson: async (path, value) => { data = value; },
  };
}

test('a saved preset comes back exactly as the form sent it', async () => {
  const store = memoryStore();
  const { preset, presets } = await savePreset(store, { name: 'My Flow', flow: flow() });
  assert.equal(preset.id, 'my-flow');
  assert.deepEqual(await readPresets(store), presets);
  const [stored] = await readPresets(store);
  assert.equal(stored.name, 'My Flow');
  assert.deepEqual(stored.flow, flow());
});

test('saving the same name overwrites instead of piling up copies', async () => {
  const store = memoryStore();
  await savePreset(store, { name: 'My Flow', flow: flow() });
  await savePreset(store, { name: 'My Flow', flow: { ...flow(), task: 'Updated.' } });
  const presets = await readPresets(store);
  assert.equal(presets.length, 1);
  assert.equal(presets[0].flow.task, 'Updated.');
});

test('the stored flow is still a runnable flow', async () => {
  const store = memoryStore();
  await savePreset(store, { name: 'My Flow', flow: flow() });
  const [stored] = await readPresets(store);
  const plan = await validateFlow(stored.flow, { get: async row => row });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.order, ['s-1']);
});

test('entries that could never run are skipped, not fatal', () => {
  const kept = normalizePresets([
    { name: 'good', flow: flow() },
    { name: '', flow: flow() },
    { name: 'no flow' },
    { name: 'empty', flow: { task: 't', participants: [], steps: [] } },
    'junk',
    null,
  ]);
  assert.deepEqual(kept.map(preset => preset.name), ['good']);
});

test('unnamed and colliding ids still produce a usable list', () => {
  const presets = normalizePresets([
    { name: 'Duplicate!', flow: flow() },
    { name: 'Duplicate!', flow: flow() },
  ]);
  assert.deepEqual(presets.map(preset => preset.id), ['duplicate', 'duplicate-2']);
  assert.equal(slug('  '), 'preset');
});

test('a preset without a name is rejected with an actionable error', async () => {
  const store = memoryStore();
  await assert.rejects(() => savePreset(store, { name: '   ', flow: flow() }), /name/i);
  await assert.rejects(() => savePreset(store, { name: 'x', flow: { task: 't', participants: [], steps: [] } }), /participant/i);
});
