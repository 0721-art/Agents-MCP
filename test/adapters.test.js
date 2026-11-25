import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import agy, { parseModels, parseStream } from '../src/registry/adapters/agy.js';
import codex from '../src/registry/adapters/codex.js';
import dsh, { parseDump } from '../src/registry/adapters/dsh.js';
import { ompModels } from '../src/registry/adapters/omp.js';

test('Codex reads exact local model IDs and reasoning levels', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-mcp-codex-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'models_cache.json'), JSON.stringify({ models: [{
    slug: 'sample-from-cache', display_name: 'Sample from cache',
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
  }] }));
  await writeFile(join(dir, 'config.toml'), 'model = "sample-from-cache"\nmodel_reasoning_effort = "high"\n');
  const catalog = await codex.probe({ exe: process.execPath, env: { ...process.env, CODEX_HOME: dir } });
  assert.equal(catalog.ok, true);
  assert.deepEqual(catalog.models[0], {
    id: 'sample-from-cache', label: 'Sample from cache', efforts: ['low', 'high'], defaultEffort: 'high',
  });
  const args = codex.resumeArgs({ model: catalog.models[0].id, effort: 'high', sessionId: 'fixture-session', prompt: 'new turn' });
  assert.deepEqual(args.args.slice(-2), ['fixture-session', '-']);
  assert.equal(args.stdin, 'new turn');
});

test('Antigravity preserves CLI model IDs and uses suffix-defined efforts', () => {
  const listing = 'Available models:\n  - example-neon-low\n  - example-neon-high\n  - example-orchestrator\n';
  const [low, high, defaultOnly] = parseModels(listing);
  assert.deepEqual([low, high, defaultOnly].map(model => [model.id, model.efforts]), [
    ['example-neon-low', ['low']], ['example-neon-high', ['high']], ['example-orchestrator', ['default']],
  ]);
  const { args, stdin } = agy.buildArgs({ model: low.id, effort: 'low', prompt: 'untrusted & literal' });
  assert.deepEqual(args, ['--model', low.id, '--mode', 'plan',
    '--input-format', 'stream-json', '--output-format', 'stream-json']);
  assert.deepEqual(JSON.parse(stdin), { event: 'user', message: { content: 'untrusted & literal' } });
});

test('Antigravity stream events yield the final answer and session', () => {
  const stream = parseStream;
  assert.deepEqual(stream('{"event":"init","conversation_id":"c1","init":{"model":"m"}}').sessionId, 'c1');
  assert.deepEqual(stream('{"event":"step_update","step_update":{"state":"ACTIVE","text_delta":"OK","step_type":"agent_response"}}'),
    { type: 'assistant', text: 'OK', sessionId: undefined });
  assert.deepEqual(stream('{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"OK\\n"}}'),
    { type: 'result', text: 'OK\n', sessionId: 'c1' });
  assert.equal(stream('{"event":"result","result":{"status":"ERROR","response":"boom"}}').type, 'error');
});

test('OMP reads explicit model efforts without exposing other YAML fields', () => {
  const yaml = [
    'providers:', '  sample:', '    models:', '      - contextWindow: 123',
    '        id: sample/model', '        name: Configured model', '        reasoning: true',
    '        thinking:', '          efforts:', '            - low', '            - max', '          mode: effort',
    '      - id: no-reasoning', '        reasoning: false',
  ].join('\n');
  assert.deepEqual(ompModels(yaml, 'max'), [
    { id: 'sample/sample/model', label: 'Configured model', efforts: ['off', 'low', 'max'], defaultEffort: 'max' },
    { id: 'sample/no-reasoning', label: 'sample/no-reasoning', efforts: ['off'], defaultEffort: 'off' },
  ]);
});

test('DSH patches the headless profile and cleans up the overlay', async t => {
  const dump = ['# == @deepseek-ai/dsh-base',
    "- id: agent-default-model", "  name: '@deepseek-ai/dsh-agent-default-model'", '  config:',
    '    provider: deepseek-official', '    model: deepseek-flash', '- id: jobs',
  ].join('\n');
  assert.deepEqual(parseDump(dump), { provider: 'deepseek-official', model: 'deepseek-flash' });
  const options = dsh.buildArgs({
    model: 'deepseek-official/deepseek-flash', effort: 'high', permission: 'read', prompt: 'Task:\nprobe',
  });
  t.after(() => options.cleanup());
  const patchPath = options.args[options.args.indexOf('--patch') + 1];
  const patch = await readFile(patchPath, 'utf8');
  assert.match(patch, /provider: deepseek-official/);
  assert.match(patch, /reasoningEffort: high/);
  assert.equal(options.args.includes('--model'), false);
  assert.deepEqual(options.args.slice(-5), ['--permission-mode', 'read-only', '--approval-policy', 'never', '-']);
  assert.equal(options.stdin, 'Task:\nprobe');
  options.cleanup();
  await assert.rejects(readFile(dirname(patchPath), 'utf8'), { code: 'ENOENT' });
});
