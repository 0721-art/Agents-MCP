// A big tool result should cost what it is worth: the text copy becomes a summary while the
// structured copy keeps every field. Small answers stay byte-identical to before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProtocol } from '../src/mcp/protocol.js';
import { summarize, textLimit } from '../src/mcp/summary.js';

const agents = Array.from({ length: 40 }, (unused, index) => ({
  id: `agent-${index}`,
  available: true,
  models: Array.from({ length: 30 }, (ignored, model) => ({ id: `m${model}`, efforts: ['low', 'high'] })),
}));

function fake(listResult) {
  const calls = [];
  return {
    calls,
    service: {
      mcpEnabled: () => true,
      redact: value => value,
      noteCall: call => calls.push(call),
      notice: () => ({ notice: 'Agents-MCP 已启用' }),
      instructions: () => 'state line',
      listAgents: async () => listResult,
      planFlow: async () => ({ ok: true, order: ['write', 'review'], errors: [], warnings: [] }),
      status: async () => ({ runId: 'r1', status: 'running', round: 2,
        steps: { write: { status: 'PASS' }, review: { status: 'running' } }, events: [], artifacts: {} }),
    },
  };
}

test('a large answer is summarised in the text copy but kept whole in structuredContent', async () => {
  const { service } = fake(agents);
  const rpc = createProtocol(service);
  const reply = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agents_list' } });
  const text = reply.result.content[0].text;
  assert.ok(Buffer.byteLength(text, 'utf8') < 600, `summary should be short, got ${Buffer.byteLength(text)} bytes`);
  assert.match(text, /40 个 agent/);
  assert.match(text, /Agents-MCP 已启用/);
  assert.equal(reply.result.structuredContent.agents.length, 40, 'the data itself is untouched');
  assert.equal(reply.result.structuredContent.agents[0].models.length, 30);
});

test('a small answer still travels as plain JSON, exactly as before', async () => {
  const { service } = fake([{ id: 'fixture', available: true, models: [{ id: 'm', efforts: ['off'] }] }]);
  const rpc = createProtocol(service);
  const reply = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agents_list' } });
  const text = reply.result.content[0].text;
  assert.ok(Buffer.byteLength(text, 'utf8') <= textLimit);
  assert.deepEqual(JSON.parse(text), reply.result.structuredContent);
});

test('the summary names what the agent needs and never drops the state sentence', () => {
  const line = summarize('agents_list', { agents, tellUser: 'Agents-MCP 已禁用' });
  assert.match(line, /agent-0 可用（30 模型）/);
  assert.match(line, /structuredContent/);
  assert.match(line, /Agents-MCP 已禁用/);
  assert.ok(Buffer.byteLength(line) < 600);
});

test('a run summary lists step states without pasting the record', () => {
  const line = summarize('agents_status', { runId: 'r1', status: 'running', round: 2,
    steps: { write: { status: 'PASS' }, review: { status: 'running' } }, events: [1, 2, 3],
    artifacts: { plan: 'plan.md' }, tellUser: 'Agents-MCP 已启用' });
  assert.match(line, /r1/);
  assert.match(line, /write=PASS/);
  assert.match(line, /review=running/);
  assert.match(line, /事件 3 条/);
  assert.match(line, /Agents-MCP 已启用/);
});
