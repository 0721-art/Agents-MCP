import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '../src/server.js';
import { createHttp } from '../src/panel/server.js';
import { createProtocol } from '../src/mcp/protocol.js';
import { startStdio } from '../src/mcp/transport-stdio.js';
import { createRedactor } from '../src/util/redact.js';
import { executeFlow, validateFlow } from '../src/engine/flow.js';
import { executeDispatch, parseBlocks } from '../src/engine/dispatch.js';

const actor = { agent: 'fixture', model: 'fixture-model', effort: 'low' };
const flow = {
  task: 'Build and review',
  participants: [{ id: 'author', ...actor, writes: true }, { id: 'reviewer', ...actor }],
  steps: [
    { id: 'write', participant: 'author', task: 'Implement', inputs: ['task'], produces: ['patch'] },
    { id: 'review', participant: 'reviewer', task: 'changes-then-pass', dependsOn: ['write'], inputs: ['patch'] },
  ],
  loops: [{ from: 'review', to: 'write', until: 'PASS', maxRounds: 2 }],
};

async function setup(t, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agents-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, service: await open(dir, env) };
}

function open(dir, env = {}) {
  return createService({ stateDir: dir, env: { ...process.env, ...env, AGENTS_MCP_FIXTURES: '1' } });
}

async function finish(service, runId) {
  assert.ok(runId);
  for (let i = 0; i < 200; i++) {
    const status = await service.status({ runId });
    if (status.finishedAt) return status;
    await delay(35);
  }
  assert.fail('Fixture run did not finish');
}

test('the update route restarts the service only after answering', async t => {
  let restarted = 0;
  const fake = {
    getConfig: async () => ({ port: 0 }), presets: async () => [], listRuns: async () => [],
    pending: async () => [], listAgents: async () => [], redact: value => value,
    update: async () => ({ current: '0.1.0', latest: 'v0.2.0', newer: true }),
    applyUpdate: async () => ({ ok: true, restarting: true, version: 'v0.2.0', restart: 'launcher' }),
  };
  const http = await createHttp(fake, { port: 0, onUpdate: () => { restarted += 1; } });
  t.after(() => new Promise(resolve => http.close(resolve)));
  let response;
  try {
    response = await fetch('http://127.0.0.1:' + http.address().port + '/api/update/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
  } catch (error) {
    if (process.platform === 'win32' && error.cause?.code === 'EACCES') {
      t.skip('Loopback TCP denied by this Windows sandbox.');
      return;
    }
    throw error;
  }
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.restarting, true);
  await delay(50);
  assert.equal(restarted, 1, 'the restart hook runs after the response is finished');
});

test('an update that also replaces the window leaves the restart to that window', async t => {
  let restarted = 0;
  const fake = {
    getConfig: async () => ({ port: 0 }), presets: async () => [], listRuns: async () => [],
    pending: async () => [], listAgents: async () => [], redact: value => value,
    update: async () => ({ current: '0.1.0', latest: 'v0.2.0', newer: true }),
    applyUpdate: async () => ({ ok: true, restarting: true, version: 'v0.2.0', restart: 'panel' }),
  };
  const http = await createHttp(fake, { port: 0, onUpdate: () => { restarted += 1; } });
  t.after(() => new Promise(resolve => http.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + http.address().port + '/api/update/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.restart, 'panel');
  await delay(50);
  assert.equal(restarted, 0, 'the window restarts itself instead of the service');
});

test('the panel can ask what this machine can actually do', async t => {
  const { dir, service } = await setup(t);
  const report = await service.health();
  assert.equal(report.state.dir, dir);
  assert.equal(typeof report.state.writable, 'boolean');
  assert.ok(Array.isArray(report.locations));
  assert.equal(typeof report.update.source, 'string');
  assert.equal(report.version, (await service.getConfig()).version);
  // Redaction runs over every payload the panel receives; folder kinds must survive it.
  const redacted = service.redact(report);
  assert.deepEqual(redacted.locations.map(location => location.kind), ['desktop', 'programs']);
});

test('gate requires a run request before accepting a decision', async t => {
  const { service } = await setup(t);
  await assert.rejects(service.gate({ task: flow.task, decision: 'enable' }), /run the task first/i);
  await assert.rejects(service.gate({ taskId: 'unasked', decision: 'enable' }), /run the task first/i);
  const pending = await service.runFlow(flow);
  assert.equal(pending.status, 'confirmation_required');
  assert.equal((await service.gate({ task: flow.task, decision: 'enable' })).status, 'enabled');
});

test('gate binds a grant to whitespace inside a quoted literal', async t => {
  const { service } = await setup(t);
  const original = { ...flow, task: 'Print "two words"' };
  const changed = { ...original, task: 'Print "two  words"' };
  const first = await service.runFlow(original);
  await service.gate({ task: original.task, decision: 'enable' });
  const second = await service.runFlow(changed);
  assert.equal(second.status, 'confirmation_required');
  assert.notEqual(first.taskId, second.taskId);
  await assert.rejects(service.runFlow({ ...changed, taskId: first.taskId }), { code: 'E_TASK_ID' });
});

test('gate re-asks for legacy approvals and normalizes only CRLF', async t => {
  const { dir } = await setup(t);
  const taskId = 'legacy-task';
  const task = 'Print "two words"';
  await writeFile(join(dir, 'gate.json'), JSON.stringify({ [taskId]: {
    taskId, task, status: 'enabled', decision: 'enable', fingerprint: createHash('sha256').update(task).digest('hex'),
  } }));
  const service = await open(dir);
  await assert.rejects(service.gate({ taskId, decision: 'enable' }), /run the task first/i);
  assert.ok((await service.runFlow({ ...flow, taskId, task })).question);
  const first = await service.runFlow({ ...flow, task: 'Start\r\nFinish' });
  assert.deepEqual(await service.runFlow({ ...flow, task: 'Start\nFinish' }),
    { status: first.status, taskId: first.taskId });
  assert.notEqual((await service.runFlow({ ...flow, task: ' Start\nFinish' })).taskId, first.taskId);
});

test('a stale confirmation stops blocking the banner and is asked again', async t => {
  const { dir, service } = await setup(t);
  const taskId = 'stale-antigravity-install';
  const task = 'Install the Antigravity CLI.';
  const fingerprint = createHash('sha256').update(task.replace(/\r\n/g, '\n')).digest('hex');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  await writeFile(join(dir, 'gate.json'), JSON.stringify({ [taskId]: {
    status: 'confirmation_required', taskId, task, mode: 'A', question: '是否为此任务启用 Agents-MCP？',
    fingerprint, fingerprintVersion: 2, createdAt: old,
  } }));
  const restarted = await open(dir);
  assert.deepEqual(await restarted.pending(), []);
  const asked = await restarted.runFlow(flow);
  assert.equal(asked.status, 'confirmation_required');
  assert.ok(Date.parse(asked.createdAt) > Date.parse(old));
});

test('dismissing a question forgets it without enabling anything', async t => {
  const { dir, service } = await setup(t);
  const pending = await service.runFlow(flow);
  assert.equal(pending.status, 'confirmation_required');
  assert.equal((await service.gate({ taskId: pending.taskId, decision: 'dismiss' })).status, 'dismissed');
  assert.deepEqual(await service.pending(), []);
  await assert.rejects(service.gate({ taskId: pending.taskId, decision: 'enable' }), /run the task first/i);
  assert.equal((await service.runFlow(flow)).status, 'confirmation_required');
});

test('gate persists and Mode A hands off artifacts through a review loop', async (t) => {
  const { dir, service } = await setup(t);
  const pending = await service.runFlow(flow);
  assert.equal(pending.status, 'confirmation_required');
  assert.ok(pending.question);
  assert.deepEqual(await service.runFlow(flow), { status: pending.status, taskId: pending.taskId });
  assert.equal((await service.pending()).length, 1);
  await service.gate({ taskId: pending.taskId, decision: 'enable' });
  await assert.rejects(service.runFlow({ ...flow, task: 'Changed task', taskId: pending.taskId }), { code: 'E_TASK_ID' });
  const restarted = await open(dir);
  const { runId } = await restarted.runFlow(flow);
  const first = await service.status({ runId, after: 0 });
  const update = await service.status({ runId, after: first.timelineCursor, waitMs: 3000 });
  assert.ok(update.timeline.length || update.finishedAt);
  const result = await finish(restarted, runId);
  assert.equal(result.status, 'PASS');
  assert.equal(result.steps.review.round, 2);
  assert.ok(result.artifacts.includes('write-patch.md'));
  assert.deepEqual(result.timeline.filter(event => event.kind === 'handoff' || event.kind === 'review')
    .map(event => [event.kind, event.from, event.to, event.round, event.detail]), [
    ['handoff', 'write', 'review', 1, 'write-patch.md'],
    ['review', 'review', 'write', 2, 'Please revise the patch.'],
    ['handoff', 'write', 'review', 2, 'write-patch.md'],
  ]);
  assert.equal(result.timeline.at(-1).kind, 'run_finished');
  const protocol = createProtocol(await open(dir));
  const messages = [];
  let after = 0;
  let page;
  do {
    const progress = [];
    const reply = await protocol({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'agents_status', arguments: { runId, after }, _meta: { progressToken: 'watch' } } },
    event => progress.push(event.params));
    page = reply.result.structuredContent;
    assert.equal(reply.result.isError, false);
    assert.match(reply.result.content[0].text, /协作/);
    assert.equal(page.timelineCursor, after + page.timeline.length);
    assert.deepEqual(progress.map(event => event.progress), Array.from({ length: page.timeline.length + 2 }, (_, i) => i + 1));
    page.timeline.forEach((event, i) => assert.ok(progress[i + 1].message.startsWith(event.message)));
    messages.push(...page.timeline);
    after = page.timelineCursor;
  } while (page.timelineHasMore);
  assert.deepEqual(messages, result.timeline);
  assert.deepEqual((await restarted.status({ runId, after })).timeline, []);
  assert.match(await readFile(result.reportPath, 'utf8'), /PASS/);
  assert.equal((await restarted.runFlow({ ...flow, task: 'Other task' })).status, 'confirmation_required');
  await restarted.setConfig({ gate: { modeA: false } });
  assert.equal((await restarted.runFlow(flow)).status, 'mode_disabled');
  assert.equal((await restarted.delegate({ ...actor, task: 'Delegation' })).status, 'confirmation_required');
});

test('a run keeps each agent reasoning beside its answer', async t => {
  const { dir, service } = await setup(t);
  const single = {
    task: 'thinking-demo',
    participants: [{ id: 'author', ...actor, writes: true }],
    steps: [{ id: 'write', participant: 'author', task: 'thinking-demo' }],
  };
  const pending = await service.runFlow(single);
  assert.equal(pending.status, 'confirmation_required');
  await service.gate({ taskId: pending.taskId, decision: 'enable' });
  const { runId } = await service.runFlow(single);
  const result = await finish(service, runId);
  const reasoning = result.events.filter(event => event.type === 'reasoning').map(event => [event.step, event.text]);
  assert.deepEqual(reasoning, [['write', 'Fixture reasons about the task.'], ['write', 'Fixture summary for the user.']]);
  assert.equal(result.steps.write.tokens.reasoningTokens, 42);
  assert.deepEqual(result.timeline.filter(event => event.kind === 'progress').map(event => event.detail),
    ['Fixture summary for the user.']);
  const transcript = await readFile(join(dir, 'runs', runId, 'steps', 'write.md'), 'utf8');
  assert.match(transcript, /# Thinking\n\nFixture reasons about the task\.\n\nFixture summary for the user\.\n\n# Answer/);
});

test('a review loop starts the re-run step with fresh reasoning', async t => {
  const { dir, service } = await setup(t);
  const loop = {
    task: 'loop thinking',
    participants: [{ id: 'author', ...actor, writes: true }, { id: 'reviewer', ...actor }],
    steps: [
      { id: 'write', participant: 'author', task: 'thinking-demo' },
      { id: 'review', participant: 'reviewer', task: 'changes-then-pass', dependsOn: ['write'] },
    ],
    loops: [{ from: 'review', to: 'write', until: 'PASS', maxRounds: 2 }],
  };
  const pending = await service.runFlow(loop);
  await service.gate({ taskId: pending.taskId, decision: 'enable' });
  const { runId } = await service.runFlow(loop);
  const result = await finish(service, runId);
  assert.equal(result.steps.write.round, 2);
  const transcript = await readFile(join(dir, 'runs', runId, 'steps', 'write.md'), 'utf8');
  assert.equal(transcript.match(/# Thinking/g).length, 1, 'the second round replaces the first round thinking');
  assert.equal(transcript.match(/Fixture reasons about the task\./g).length, 1, 'cap should not accumulate rounds');
});

test('gate preserves the task ID in responses and across restarts', async t => {
  const taskId = 'fixture-gate-id-823';
  const env = { FIXTURE_TOKEN: taskId };
  const { dir, service } = await setup(t, env);
  const protocol = createProtocol(service);
  const rpc = await protocol({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'agents_flow_run', arguments: { ...flow, task: 'Do not store ' + taskId, taskId },
  } });
  assert.equal(rpc.result.structuredContent.taskId, taskId);
  assert.match(rpc.result.structuredContent.task, /REDACTED/);
  const restarted = await open(dir, env);
  assert.equal((await restarted.pending())[0].taskId, taskId);
  assert.equal((await restarted.gate({ taskId, decision: 'disable' })).taskId, taskId);
});

test('Mode A rejects cycles and unsupported effort, and bounds review retries', async (t) => {
  const { service } = await setup(t);
  const cyclic = structuredClone(flow);
  cyclic.steps[0].dependsOn = ['review'];
  cyclic.participants[0].effort = 'impossible';
  const plan = await service.planFlow(cyclic);
  assert.equal(plan.ok, false);
  assert.match(JSON.stringify(plan.errors), /cycle/i);
  assert.match(JSON.stringify(plan.errors), /effort/i);
  const stuck = structuredClone(flow);
  stuck.steps[1].task = 'always-changes';
  await service.setConfig({ gate: { policy: 'auto-enable' } });
  const { runId } = await service.runFlow(stuck);
  const result = await finish(service, runId);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.steps.review.round, 2);
});

test('Mode A previews review barriers and answers from the effective terminal step', async () => {
  const definition = structuredClone(flow);
  definition.steps.splice(1, 0, { id: 'publish', participant: 'author', task: 'Publish', dependsOn: ['write'] });
  const plan = await validateFlow(definition, { get: async () => {} });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.order, ['write', 'review', 'publish']);
  const seen = [];
  const context = () => ({
    state: { steps: {}, warnings: [] }, config: { maxParallel: 1 }, signal: new AbortController().signal,
    save: async () => {}, note: () => {}, transcript: async () => {}, artifact: async name => name,
    async invoke(id) {
      seen.push(id);
      return id === 'check' ? { failed: true, answer: 'failed check' } : { answer: id + ' answer\nVERDICT: PASS' };
    },
  });
  const result = await executeFlow(context(), definition, plan);
  assert.deepEqual(seen, plan.order);
  assert.equal(result.answer, 'publish answer');

  definition.steps[1].dependsOn.push('check');
  definition.steps.unshift({ id: 'summary', participant: 'author', task: 'Summarize' },
    { id: 'check', participant: 'author', task: 'Check' });
  const blocked = await validateFlow(definition, { get: async () => {} });
  assert.equal(blocked.ok, true);
  assert.equal((await executeFlow(context(), definition, blocked)).answer, 'summary answer');
});

test('Mode A rejects nested review regions with an overlap error', async () => {
  const definition = structuredClone(flow);
  definition.steps[1].dependsOn = ['revise'];
  definition.steps.splice(1, 0, { id: 'revise', participant: 'author', task: 'Revise', dependsOn: ['write'] });
  definition.steps.push({ id: 'outer', participant: 'reviewer', task: 'Final review', dependsOn: ['review'] });
  definition.loops[0].to = 'revise';
  definition.loops.push({ from: 'outer', to: 'write', until: 'PASS', maxRounds: 2 });
  const plan = await validateFlow(definition, { get: async () => {} });
  assert.equal(plan.ok, false);
  assert.match(plan.errors[0].message, /review regions overlap/i);
});

test('Mode A aborts an active sibling before unwinding a failed step', async () => {
  const definition = { ...flow, loops: [], steps: [
    { id: 'broken', participant: 'author', task: 'Broken' },
    { id: 'sibling', participant: 'author', task: 'Sibling' },
  ] };
  const plan = await validateFlow(definition, { get: async () => {} });
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), 1000);
  let abortedSibling = false;
  try {
    await assert.rejects(executeFlow({
      state: { steps: {}, warnings: [] }, config: { maxParallel: 2 }, signal: controller.signal,
      abort: () => { abortedSibling = true; controller.abort(); }, save: async () => {}, note: () => {}, transcript: async () => {},
      async invoke(id) {
        if (id === 'broken') throw new Error('step failed');
        await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
        return { answer: 'cancelled' };
      },
    }, definition, plan), /step failed/);
    assert.equal(abortedSibling, true);
  } finally {
    clearTimeout(watchdog);
  }
});

test('Mode B enforces delegation caps and resumes with worker results', async (t) => {
  const { service } = await setup(t);
  await service.setConfig({ gate: { policy: 'auto-enable' } });
  const { runId } = await service.delegate({ ...actor, task: 'delegate-many', maxDelegations: 2 });
  const result = await finish(service, runId);
  assert.equal(result.status, 'PASS');
  assert.equal(result.delegations, 2);
  assert.deepEqual(result.delegationTree.map(edge => [edge.parent, edge.status]), [['main', 'PASS'], ['main', 'PASS']]);
  for (const { id } of result.delegationTree) {
    const sent = result.timeline.findIndex(event => event.kind === 'delegate' && event.from === 'main' && event.to === id);
    const back = result.timeline.findIndex(event => event.kind === 'delegation_result' && event.from === id && event.to === 'main');
    const resumed = result.timeline.findIndex(event => event.kind === 'step_started' && event.step === 'main-r2');
    assert.ok(sent >= 0 && sent < back && back < resumed);
  }
  assert.match(await readFile(result.reportPath, 'utf8'), /resumed.*cap/s);
});

test('Mode B parses protocol blocks containing Unicode line and paragraph separators', () => {
  const data = { task: 'one\u2028two\u2029three' };
  const line = '@@AGENTS_MCP delegate ' + JSON.stringify(data);
  assert.deepEqual(parseBlocks(line), [{ kind: 'delegate', data }]);
});

test('role drafting is asynchronous and captured output and configuration protect secrets', async (t) => {
  const value = 'fake-fixture-value-823';
  const { service } = await setup(t, { FIXTURE_API_KEY: value });
  await assert.rejects(service.setConfig({ agents: { fixture: { env: { FIXTURE_API_KEY: value } } } }),
    { code: 'E_SECRET_IN_CONFIG' });
  const { runId } = await service.draftRole({ ...actor, brief: 'echo-secret' });
  const result = await finish(service, runId);
  assert.match(result.answer, /REDACTED/);
  for (const file of ['request.md', 'events.jsonl', 'report.md', 'state.json', 'steps/draft.md']) {
    const content = await readFile(join(result.directory, file), 'utf8');
    assert.ok(!content.includes(value), file);
  }
});

test('redaction preserves JSON and covers short secrets, auth and proxies', () => {
  const redact = createRedactor({ FIXTURE_TOKEN: 'q7', HTTPS_PROXY: 'http://proxy-user:proxy-pass@localhost' });
  const report = { accessToken: 'xy', report: 'last item API_KEY=z' };
  const expected = { accessToken: '[REDACTED]', report: 'last item API_KEY=[REDACTED]' };
  const cleaned = redact(JSON.stringify(report));
  assert.deepEqual(JSON.parse(cleaned), expected);
  assert.equal(redact(cleaned), cleaned);
  assert.deepEqual(redact(report), expected);
  assert.deepEqual(JSON.parse(redact(JSON.stringify({ report: 'API_KEY=z"w' }))), { report: 'API_KEY=[REDACTED]' });
  assert.deepEqual(redact({ clientSecret: 'a', dbPassword: 'b', credentials: 'c', authorization: 'd' }),
    { clientSecret: '[REDACTED]', dbPassword: '[REDACTED]', credentials: '[REDACTED]', authorization: '[REDACTED]' });
  assert.equal(redact('token=f Basic dXNlcjpwYXNz Bearer abc'), 'token=[REDACTED] Basic [REDACTED] Bearer [REDACTED]');
  assert.equal(redact('q7 proxy-user proxy-pass'), '[REDACTED] [REDACTED] [REDACTED]');
  assert.equal(redact('socks5://other:secret@localhost:8080'), 'socks5://[REDACTED]@localhost:8080');
  assert.equal(redact('socks://other:secret@localhost'), 'socks://[REDACTED]@localhost');
  for (const text of ['{"progressToken":1}', '{"token":null}', '{"credentials":{"type":"oauth"}}', '{"token":["a"]}']) {
    assert.equal(redact(text), text);
    assert.doesNotThrow(() => JSON.parse(redact(text)));
  }
  assert.deepEqual(redact({ token: 42, progressToken: 1, note: 'ok' }), { token: 42, progressToken: 1, note: 'ok' });
  assert.deepEqual(JSON.parse(redact(JSON.stringify({ report: 'API_KEY="abc\\"def"' }))), { report: 'API_KEY="[REDACTED]"' });
  assert.equal(redact('PROXY_AUTHORIZATION=abc abc'), 'PROXY_AUTHORIZATION=[REDACTED] abc');
  assert.deepEqual(redact({ proxyAuthorization: 'x', user: 'y' }), { proxyAuthorization: '[REDACTED]', user: 'y' });
});

test('a cancelled delegation reports cancelled rather than failed', async () => {
  const controller = new AbortController();
  const ctx = {
    state: { warnings: [] }, config: { strengths: {} }, signal: controller.signal,
    registry: { list: async () => [], get: async () => ({ adapter: {} }) },
    invoke: async () => {
      controller.abort();
      return { failed: true, answer: 'Cancelled.', assistant: [] };
    },
    transcript: async () => {}, save: async () => {}, note: () => {}, stepPath: id => id, redact: text => text,
  };
  const result = await executeDispatch(ctx, { ...actor, task: 'Do work' },
    { maxDepth: 2, maxDelegations: 2, maxParallel: 1 });
  assert.equal(result.status, 'cancelled');
});

test('shutdown refuses a run still waiting on validation', async t => {
  const { dir, service } = await setup(t);
  const starting = service.draftRole({ ...actor, brief: 'Draft a responsibility' });
  const rejected = assert.rejects(starting, { code: 'E_CLOSING' });
  await service.close();
  await rejected;
  assert.deepEqual(await service.listRuns(), []);
  assert.deepEqual(await readdir(join(dir, 'runs')).catch(() => []), []);
});

test('malformed state errors identify the file without its contents', async t => {
  const { dir } = await setup(t);
  await writeFile(join(dir, 'config.json'), 'fixture-invalid-credential');
  await assert.rejects(open(dir), error => error instanceof SyntaxError
    && error.message.includes('config.json') && !error.message.includes('fixture-invalid-credential'));
});

test('stdio handles a broken output pipe and runs a rejecting close hook', async t => {
  const { service } = await setup(t);
  const input = new PassThrough();
  const output = new Writable({
    write(_data, _encoding, callback) { callback(Object.assign(new Error('Broken pipe'), { code: 'EPIPE' })); },
  });
  const { promise, resolve } = Promise.withResolvers();
  startStdio(service, { input, output, async onClose() { resolve(); throw new Error('Close failed'); } });
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  await promise;
  input.end();
});

test('HTTP serves the panel and shares gate and runs with MCP', async (t) => {
  const { service } = await setup(t);
  const http = await createHttp(service, { port: 0 });
  t.after(() => new Promise(resolve => http.close(resolve)));
  const base = 'http://127.0.0.1:' + http.address().port;
  assert.equal(http.address().address, '127.0.0.1');
  let fetchLocal = (path, options) => fetch(base + path, options);
  try {
    await (await fetchLocal('/')).text();
  } catch (error) {
    if (process.platform !== 'win32' || error.cause?.code !== 'EACCES') throw error;
    t.diagnostic('Loopback TCP denied by this Windows sandbox. Checking the same HTTP handler over a local named pipe.');
    const pipe = '\\\\.\\pipe\\agents-mcp-test-' + process.pid;
    const transport = createServer(http.listeners('request')[0]);
    await new Promise((resolve, reject) => {
      transport.once('error', reject);
      transport.listen(pipe, resolve);
    });
    t.after(() => new Promise(resolve => transport.close(resolve)));
    fetchLocal = (path, { method = 'GET', headers, body } = {}) => new Promise((resolve, reject) => {
      const req = request({ socketPath: pipe, path, method, headers: { Host: new URL(base).host, ...headers } }, async res => {
        try {
          const chunks = [];
          for await (const chunk of res) chunks.push(chunk);
          resolve(new Response(res.statusCode === 202 ? null : Buffer.concat(chunks),
            { status: res.statusCode, headers: res.headers }));
        } catch (failure) {
          reject(failure);
        }
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  const get = async (path) => (await fetchLocal(path)).json();
  const post = async (path, body) => fetchLocal(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.ok((await get('/api/agents')).some(agent => agent.id === 'fixture'));
  for (const path of ['/', '/panel.js', '/panel.css']) {
    const response = await fetchLocal(path);
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /https?:\/\//);
  }
  const init = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal((await init.json()).result.serverInfo.name, 'agents');
  const session = init.headers.get('mcp-session-id');
  const toolList = await fetchLocal('/mcp', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'Mcp-Session-Id': session,
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  assert.equal((await toolList.json()).result.tools.length, 8);
  assert.equal((await fetchLocal('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.invalid' }, body: '{}',
  })).status, 403);
  const pending = await (await post('/api/flow/run', flow)).json();
  assert.equal((await get('/api/gate/pending'))[0].taskId, pending.taskId);
  const rpc = createProtocol(service);
  assert.equal(await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'missing' })).error.code, -32601);
  const unknown = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'missing' } });
  assert.equal(unknown.result.structuredContent.code, 'E_TOOL');
  assert.equal(unknown.result.isError, true);
  await rpc({ jsonrpc: '2.0', id: 1, method: 'logging/setLevel', params: { level: 'info' } });
  const notifications = [];
  await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'agents_list', _meta: { progressToken: 'fixture-token' } } }, event => notifications.push(event.method));
  assert.deepEqual(notifications, ['notifications/progress', 'notifications/progress', 'notifications/message']);
  const gate = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'agents_gate', arguments: { decision: 'enable', taskId: pending.taskId },
  } });
  assert.equal(gate.result.structuredContent.status, 'enabled');
  const { runId } = await (await post('/api/flow/run', flow)).json();
  assert.equal((await finish(service, runId)).status, 'PASS');
  assert.ok((await get('/api/runs')).some(run => run.runId === runId));
  const stream = await fetchLocal('/mcp', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'Mcp-Session-Id': session, Accept: 'text/event-stream',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'agents_status', arguments: { runId, after: 0 }, _meta: { progressToken: 'conversation' },
  } }) });
  const packets = (await stream.text()).split('\n').filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)));
  assert.ok(packets.some(event => event.method === 'notifications/progress' && event.params.message.includes('传递产物')));
  assert.equal(packets.at(-1).result.structuredContent.runId, runId);
  const draft = await (await post('/api/draft-role', { ...actor, brief: 'Review changes' })).json();
  assert.match((await finish(service, draft.runId)).answer, /Review changes/);
});

test('the panel can ask the service to stop', async (t) => {
  const { service } = await setup(t);
  let stops = 0;
  const http = await createHttp(service, { port: 0, onShutdown: () => { stops += 1; } });
  t.after(() => new Promise(resolve => http.close(resolve)));
  const base = 'http://127.0.0.1:' + http.address().port;
  let response;
  try {
    response = await fetch(base + '/api/shutdown', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
  } catch (error) {
    if (process.platform === 'win32' && error.cause?.code === 'EACCES') {
      t.skip('Loopback TCP denied by this Windows sandbox.');
      return;
    }
    throw error;
  }
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { stopping: true });
  for (let attempt = 0; attempt < 40 && stops === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(stops, 1);
});
