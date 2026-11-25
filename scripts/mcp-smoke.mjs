import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const dir = await mkdtemp(join(tmpdir(), 'agents-mcp-smoke-'));
const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/agents-mcp.js', import.meta.url))], {
  env: { ...process.env, AGENTS_MCP_HOME: dir, AGENTS_MCP_FIXTURES: '1' },
  stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
});
const exited = new Promise(resolve => child.once('close', resolve));
const replies = new Map();
const lines = createInterface({ input: child.stdout });
let sequence = 0;
let fatal;
function fail(error) {
  fatal = error;
  for (const { reject } of replies.values()) reject(error);
  replies.clear();
}
lines.on('line', line => {
  try {
    const response = JSON.parse(line);
    const reply = replies.get(response.id);
    if (!reply) return;
    replies.delete(response.id);
    if (response.error || response.result?.isError) reply.reject(new Error(JSON.stringify(response)));
    else reply.resolve(response.result);
  } catch (error) {
    fail(error);
  }
});
child.on('error', fail);
child.once('exit', () => fail(new Error('MCP server exited.')));
child.stdin.on('error', fail);
const timer = setTimeout(() => fail(new Error('MCP smoke timed out.')), 60_000);
function rpc(method, params) {
  if (fatal) throw fatal;
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    replies.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const tool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).structuredContent;

try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  assert.equal(init.serverInfo.name, 'agents');
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  assert.equal((await rpc('tools/list')).tools.length, 8);
  assert.ok((await tool('agents_list', {})).agents.some(agent => agent.id === 'fixture'));
  const flow = JSON.parse(await readFile(new URL('../fixtures/flow-two-step-loop.json', import.meta.url), 'utf8'));
  const pending = await tool('agents_flow_run', flow);
  assert.equal(pending.status, 'confirmation_required');
  await tool('agents_gate', { taskId: pending.taskId, decision: 'enable' });
  const { runId } = await tool('agents_flow_run', flow);
  assert.ok(runId);
  let status;
  do {
    await delay(40);
    status = await tool('agents_status', { runId });
  } while (!status.finishedAt);
  assert.equal(status.status, 'PASS');
  assert.ok(Object.values(status.steps).every(step => step.status === 'PASS'));
  assert.equal(status.steps.review.round, 2);
  assert.ok((await readFile(status.reportPath, 'utf8')).trim());
  assert.equal((await tool('agents_flow_run', { ...flow, task: 'A new fixture task' })).status, 'confirmation_required');
  process.stdout.write('MCP stdio smoke PASS. Fixture review loop, report, and per-task gate verified.\n');
} finally {
  clearTimeout(timer);
  child.stdin.end();
  const kill = setTimeout(() => child.kill(), 2000);
  await exited;
  clearTimeout(kill);
  lines.close();
  await rm(dir, { recursive: true, force: true });
}
