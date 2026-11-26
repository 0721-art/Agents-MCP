// One switch decides whether this server is allowed to start anything. The protocol has to
// say so in words a model can repeat, and the refusal has to name the switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configWith, defaults } from '../src/config.js';
import { createProtocol } from '../src/mcp/protocol.js';
import { createService } from '../src/server.js';

const actor = { agent: 'fixture', model: 'fixture-model', effort: 'low' };
const flow = {
  task: 'Build and review',
  participants: [{ id: 'author', ...actor, writes: true }, { id: 'reviewer', ...actor }],
  steps: [
    { id: 'write', participant: 'author', task: 'Implement', inputs: ['task'], produces: ['patch'] },
    { id: 'review', participant: 'reviewer', task: 'Review', dependsOn: ['write'], inputs: ['patch'] },
  ],
};

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agents-mcp-switch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const service = await createService({ stateDir: dir, env: { ...process.env, AGENTS_MCP_FIXTURES: '1' } });
  t.after(() => service.close());
  return { service, rpc: createProtocol(service) };
}

test('the switch only accepts a boolean', () => {
  assert.equal(configWith(defaults, { enabled: false }).enabled, false);
  assert.equal(configWith(defaults, {}).enabled, true);
  assert.throws(() => configWith(defaults, { enabled: 'yes' }), error => error.code === 'E_CONFIG');
});

test('a client that connects while the server is on is told so, and how to ask once', async t => {
  const { rpc } = await setup(t);
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client' } } });
  const text = init.result.instructions;
  assert.match(text, /Agents-MCP 已启用/);
  assert.match(text, /agents_gate/);
  assert.match(text, /模式 A/);
});

test('switching it off refuses every tool call and says why', async t => {
  const { service, rpc } = await setup(t);
  await service.setConfig({ enabled: false });
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.match(init.result.instructions, /Agents-MCP 已停用/);
  const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(listed.result.tools.length, 8, 'tools stay listed so clients do not break');
  const call = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agents_list' } });
  assert.equal(call.result.isError, true);
  assert.equal(call.result.structuredContent.code, 'E_DISABLED');
  assert.match(call.result.structuredContent.message, /已停用/);
  assert.match(call.result.structuredContent.remedy, /启用 Agents-MCP/);
});

test('switching it back on makes the same call work again', async t => {
  const { service, rpc } = await setup(t);
  await service.setConfig({ enabled: false });
  await service.setConfig({ enabled: true });
  const call = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agents_list' } });
  assert.equal(call.result.isError, false);
  assert.ok(call.result.structuredContent.agents.some(agent => agent.id === 'fixture'));
  // The row an agent reads first also carries the sentence it should repeat to the user.
  assert.equal(call.result.structuredContent.notice, 'Agents-MCP 已启用');
});

test('the gate answer carries the sentence the agent repeats to the user', async t => {
  const { service, rpc } = await setup(t);
  const first = await service.runFlow(flow);
  assert.equal(first.status, 'confirmation_required');
  const answer = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'agents_gate', arguments: { decision: 'enable', taskId: first.taskId },
  } });
  assert.equal(answer.result.structuredContent.status, 'enabled');
  assert.match(answer.result.structuredContent.notice, /Agents-MCP 已启用/);
});

test('every answer carries the sentence the agent must say to the user', async t => {
  const { service, rpc } = await setup(t);
  const on = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agents_list' } });
  assert.equal(on.result.structuredContent.tellUser, 'Agents-MCP 已启用');

  await service.setConfig({ enabled: false });
  const off = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agents_list' } });
  assert.equal(off.result.structuredContent.tellUser, 'Agents-MCP 已停用',
    'the refusal says the same sentence, so the agent can still report the state');
});

test('the state is part of every tool description, not only the initialize handshake', async t => {
  const { rpc } = await setup(t);
  const listed = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  for (const tool of listed.result.tools) {
    assert.match(tool.description, /tell the user the current Agents-MCP state/, tool.name);
  }
});
