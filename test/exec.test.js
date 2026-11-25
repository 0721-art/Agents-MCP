import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run, nodeRuntime } from '../src/runner/exec.js';

const fixture = suffix => fileURLToPath(new URL('../fixtures/fake-agent.' + suffix, import.meta.url));

test('stdin preserves Unicode and command metacharacters, including through a Windows shim', async () => {
  const prompt = '你好 & | " % ! ^ < >\nsecond line';
  const launch = process.platform === 'win32'
    ? { exe: fixture('cmd'), args: ['--echo'] }
    : { exe: process.execPath, args: [fixture('js'), '--echo'] };
  const result = await run({ ...launch, stdin: prompt });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdoutTail).result, prompt);
});

test('timeout and cancellation stop children and grandchildren', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-mcp-exec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  async function alive(pid) {
    try {
      process.kill(pid, 0);
      if (process.platform === 'linux') {
        const status = await readFile('/proc/' + pid + '/status', 'utf8');
        if (/^State:\s+Z/m.test(status)) return false;
      }
      return true;
    } catch (error) {
      if (['ESRCH', 'ENOENT'].includes(error.code)) return false;
      throw error;
    }
  }
  for (const action of ['timeout', 'cancel']) {
    const pidsFile = join(dir, action + '.json');
    const controller = new AbortController();
    const result = run({ exe: process.execPath, args: [fixture('js'), '--tree', pidsFile],
      timeoutMs: action === 'timeout' ? 1500 : 6000, signal: controller.signal });
    let pids;
    for (let retry = 0; retry < 50 && !pids; retry++) {
      pids = await readFile(pidsFile, 'utf8').then(text => {
        try {
          return JSON.parse(text);
        } catch {
          return null; // The fixture may still be flushing the file.
        }
      }, () => null);
      if (!pids) await delay(20);
    }
    if (action === 'cancel' || !pids) controller.abort();
    const outcome = await result;
    assert.ok(pids, 'The fixture did not start its grandchildren');
    assert.equal(outcome.timedOut, action === 'timeout');
    assert.equal(outcome.cancelled, action === 'cancel');
    for (const pid of pids) {
      for (let retry = 0; retry < 20 && await alive(pid); retry++) await delay(25);
      assert.equal(await alive(pid), false, 'Process ' + pid + ' survived ' + action);
    }
  }
});

test('runner rejects setup and callback throws', async () => {
  await assert.rejects(run({ exe: null }), { code: 'ERR_INVALID_ARG_TYPE' });
  const options = { exe: process.execPath, args: [fixture('js'), '--sleep'], timeoutMs: 4000 };
  await assert.rejects(run({ ...options, onSpawn() { throw new Error('spawn callback failed'); } }), /spawn callback failed/);
  await assert.rejects(run({ ...options, stdin: {} }), { code: 'ERR_INVALID_ARG_TYPE' });
});

test('Windows batch fallback preserves a trailing backslash', { skip: process.platform !== 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-mcp-batch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const exe = join(dir, 'args.cmd');
  await writeFile(exe, '@"' + process.execPath + '" -e "console.log(JSON.stringify(process.argv.slice(1)))" -- %*\r\n');
  const args = ['E:\\', 'next'];
  const result = await run({ exe, args });
  assert.deepEqual(JSON.parse(result.stdoutTail), args);
  await assert.rejects(run({ exe, args, argvPrompt: true }), { code: 'E_SHIM_ARGUMENT' });
});

test('Windows argv prompts use resolved shims and account for quote expansion', { skip: process.platform !== 'win32' }, async () => {
  const exe = fixture('cmd');
  const args = ['--echo', 'quotes " and spaces'];
  const result = await run({ exe, args, stdin: 'prompt', argvPrompt: true });
  assert.equal(JSON.parse(result.stdoutTail).result, 'prompt');
  await assert.rejects(run({ exe, args: ['"'.repeat(17_000)], argvPrompt: true }), { code: 'E_TASK' });
});

test('Windows cancellation resolves when an exited launcher leaves pipes open', { skip: process.platform !== 'win32' }, async t => {
  const controller = new AbortController();
  const launcher = Object.assign(new EventEmitter(), {
    pid: 123, exitCode: 0, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {},
  });
  const taskkill = new EventEmitter();
  const spawn = t.mock.method(childProcess, 'spawn', exe => exe.endsWith('taskkill.exe') ? taskkill : launcher);
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
  const result = run({ exe: process.execPath, signal: controller.signal, timeoutMs: 10_000 });
  controller.abort();
  taskkill.emit('close', 128);
  // The launcher's inherited pipes stay open until the runner stops waiting.
  const deadline = new AbortController();
  try {
    const outcome = await Promise.race([result, delay(4000, null, { signal: deadline.signal })]);
    assert.equal(outcome?.cancelled, true, 'Cancellation waited for the inherited pipes');
  } finally {
    deadline.abort();
    launcher.emit('close', 0);
  }
});

test('shim unwrapping resolves a real node instead of the packaged executable', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-mcp-node-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const packaged = join(dir, 'Agents-MCP.exe');
  // Inside the single-file executable process.execPath is Agents-MCP.exe, which cannot run a JS file.
  assert.equal(nodeRuntime({}, packaged), 'node.exe');
  assert.equal(nodeRuntime({ npm_node_execpath: process.execPath, PATH: '' }, packaged), process.execPath);
  const beside = join(dir, 'node.exe');
  await writeFile(beside, '');
  assert.equal(nodeRuntime({ PATH: [join(dir, 'missing'), dir].join(process.platform === 'win32' ? ';' : ':') }, packaged), beside);
});
