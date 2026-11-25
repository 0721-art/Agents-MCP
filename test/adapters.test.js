import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import agy, { parseModels, parseStream } from '../src/registry/adapters/agy.js';
import codex from '../src/registry/adapters/codex.js';
import dsh, { discoverProviders, parseDump } from '../src/registry/adapters/dsh.js';
import { ompModels } from '../src/registry/adapters/omp.js';
import { jsonEvent } from '../src/runner/events.js';

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
  assert.deepEqual(stream('{"event":"result","result":{"status":"ERROR","response":""}}').text, 'ERROR');
  assert.deepEqual(stream('{"event":"result","result":{"status":"ERROR","error":{"message":"quota"}}}').text, 'quota');
  assert.equal(stream('{"event":"init","conversation_id":"--model"}').sessionId, undefined);
  assert.deepEqual(agy.resumeArgs({ model: 'neon-low', sessionId: '-rf' }).args.includes('--resume'), false);
  assert.deepEqual(agy.resumeArgs({ model: 'neon-low', sessionId: 'c1' }).args.slice(-2), ['--resume', 'c1']);
});

test('reasoning text and thinking tokens survive every stream shape in use', () => {
  assert.deepEqual(jsonEvent(JSON.stringify({ type: 'item.completed',
    item: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checked 17*23.' }, { text: 'Then 391.' }] } })),
  { type: 'reasoning', text: 'Checked 17*23.\nThen 391.', sessionId: undefined });
  assert.deepEqual(jsonEvent(JSON.stringify({ type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Hidden reasoning.' }] } })),
  { type: 'reasoning', text: 'Hidden reasoning.', sessionId: undefined });
  assert.equal(jsonEvent(JSON.stringify({ type: 'reasoning_delta', delta: 'Partial thought' })).text, 'Partial thought');
  assert.equal(jsonEvent(JSON.stringify({ type: 'message', reasoning_content: 'Direct field' })).text, 'Direct field');
  assert.equal(jsonEvent(JSON.stringify({ type: 'message', reasoning_content: 'thinking', content: 'The answer' })).type, 'assistant',
    'an event carrying both keeps its answer text');
  assert.equal(jsonEvent(JSON.stringify({ type: 'reasoning_delta', delta: 'chunk' })).delta, true);
  assert.deepEqual(jsonEvent(JSON.stringify({ type: 'turn.completed',
    usage: { output_tokens: 5, reasoning_output_tokens: 42 } })).usage, { outputTokens: 5, reasoningTokens: 42 });
  assert.equal(jsonEvent(JSON.stringify({ type: 'thread.started', thread_id: 't1' })).usage, undefined);
});

test('Antigravity keeps thinking deltas and thinking token counts', () => {
  const thought = parseStream(JSON.stringify({ event: 'step_update', step_update:
    { step_type: 'thought', state: 'ACTIVE', text_delta: 'Weighing options.' } }));
  assert.deepEqual({ type: thought.type, text: thought.text }, { type: 'reasoning', text: 'Weighing options.' });
  const done = parseStream(JSON.stringify({ event: 'step_update', step_update:
    { step_type: 'agent_response', state: 'DONE', usage: { input_tokens: 1, output_tokens: 2, thinking_tokens: 3 } } }));
  assert.deepEqual(done.usage, { inputTokens: 1, outputTokens: 2, reasoningTokens: 3 });
  assert.equal(parseStream(JSON.stringify({ event: 'step_update', step_update:
    { step_type: 'agent_response', state: 'DONE', text_delta: 'done\n', usage: { thinking_tokens: 40 } } })).text, 'done\n',
  'a final answer chunk must not be dropped when usage rides along');
});

test('OMP reads explicit model efforts without exposing other YAML fields', () => {  const yaml = [
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
  const empty = await mkdtemp(join(tmpdir(), 'agents-mcp-dsh-home-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const options = dsh.buildArgs({
    model: 'deepseek-official/deepseek-flash', effort: 'high', permission: 'read', prompt: 'Task:\nprobe',
    env: { USERPROFILE: empty },
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

test('DSH offers the models the user configured and hands headless their key', async t => {
  const home = await mkdtemp(join(tmpdir(), 'agents-mcp-dsh-profile-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.dsh', 'profiles', 'desktop'), { recursive: true });
  await writeFile(join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      new:',
    '        displayName: new',
    '        apiKeyEnv: NEW_API_KEY',
    '        api: openai-completions',
    '        baseURL: http://127.0.0.1:9999/v1',
    '        models:',
    '          - id: cn:deepseek-v4.1-flash',
    '            name: Deepseek-V4.1-Flash',
    '            reasoningEfforts:',
    '              off: null',
    '              low: low',
    '              high: high',
    '      many:',
    '        apiKeyEnv: MANY_API_KEY',
    '        models:',
    '          - id: trae:glm-5.3',
    '            name: GLM-5.3',
    '- id: ui-chat',
    '  name: "@deepseek-ai/dsh-client-ui-chat"',
  ].join('\n'));
  await writeFile(join(home, '.dsh', '.credentials.yaml'), [
    'version: 1',
    'records:',
    '  client-connection/bridge:',
    '    kind: oauth',
    '    payload:',
    '      version: 1',
    '      secret: abc',
    'refs:',
    '  NEW_API_KEY: secret-value',
    '  MANY_API_KEY: many-value',
  ].join('\n'));

  const providers = discoverProviders({ USERPROFILE: home });
  assert.deepEqual(providers.map(p => p.name), ['new', 'many']);
  assert.equal(providers[0].apiKeyEnv, 'NEW_API_KEY');
  assert.deepEqual(providers[0].models[0].efforts, ['off', 'low', 'high']);
  assert.deepEqual(providers[1].models.map(m => m.name), ['GLM-5.3']);

  const probe = await dsh.probe({ exe: 'missing', env: { USERPROFILE: home } });
  assert.equal(probe.ok, true);
  assert.deepEqual(probe.models.map(m => m.id), ['new/cn:deepseek-v4.1-flash', 'many/trae:glm-5.3']);
  assert.deepEqual(probe.models[0].efforts, ['off', 'low', 'high']);
  assert.deepEqual(probe.warnings, []);

  const unsigned = await dsh.probe({ exe: 'missing', env: { USERPROFILE: home, MANY_API_KEY: '' } });
  assert.equal(unsigned.warnings.length, 0);

  const options = dsh.buildArgs({ model: 'new/cn:deepseek-v4.1-flash', effort: 'high', permission: 'write',
    prompt: 'Task:\ngo', env: { USERPROFILE: home } });
  t.after(() => options.cleanup());
  const patch = await readFile(options.args[options.args.indexOf('--patch') + 1], 'utf8');
  assert.match(patch, /^      new:$/m);
  assert.match(patch, /baseURL: http:\/\/127\.0\.0\.1:9999\/v1/);
  assert.doesNotMatch(patch, /many:/);
  assert.match(patch, /provider: new/);
  assert.match(patch, /model: "cn:deepseek-v4.1-flash"/);
  assert.deepEqual(options.env, { NEW_API_KEY: 'secret-value' });
});

test('DSH reads its own headless stream vocabulary', () => {
  assert.deepEqual(dsh.parseStream(JSON.stringify({ type: 'text', text: 'part' })),
    { type: 'assistant', text: 'part', sessionId: undefined });
  assert.deepEqual(
    dsh.parseStream(JSON.stringify({ type: 'final', sessionId: 's-1', text: 'done', reason: { kind: 'completed' } })),
    { type: 'result', text: 'done', sessionId: 's-1' });
  assert.deepEqual(
    dsh.parseStream(JSON.stringify({ type: 'final', sessionId: 's-1', reason: { kind: 'error', error: { message: 'boom' } } })),
    { type: 'error', text: 'boom', sessionId: 's-1' });
  const thinking = dsh.parseStream(JSON.stringify({ type: 'thinking', text: 'considering' }));
  assert.equal(thinking.type, 'reasoning');
  assert.equal(thinking.text, 'considering');
  const usage = dsh.parseStream(JSON.stringify({ type: 'status', phase: 'step_end', usage: { inputTokens: 3, outputTokens: 4 } }));
  assert.deepEqual(usage.usage, { inputTokens: 3, outputTokens: 4 });
});
