import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createService } from '../src/server.js';

test('opt-in Antigravity catalog and headless draft', { skip: process.env.AGENTS_MCP_LIVE !== '1', timeout: 90_000 }, async t => {
  const model = 'gemini-3.8-flash-low';
  const root = process.env.AGENTS_MCP_LIVE_TMP || tmpdir();
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'agents-mcp-agy-'));
  const service = await createService({ stateDir: dir, env: { ...process.env, AGENTS_MCP_FIXTURES: '0' } });
  t.after(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  const agy = (await service.listAgents()).find(agent => agent.id === 'agy');
  if (!agy?.available || !agy.models.some(entry => entry.id === model)) {
    return t.skip(agy?.reason || 'The live model is unavailable.');
  }
  const { runId } = await service.draftRole({ agent: 'agy', model, effort: 'low', brief: 'Reply with exactly OK.' });
  for (let i = 0; i < 120; i++) {
    const run = await service.status({ runId });
    if (run.finishedAt) {
      if (run.status !== 'PASS' && /\b(timeout|timed? out|authenticat|sign in|region|proxy|connection|unavailable|network|dns)\b/i.test(run.answer)) {
        return t.skip('Live provider unavailable: ' + run.answer);
      }
      assert.equal(run.status, 'PASS', run.answer);
      assert.ok(run.answer.trim());
      return;
    }
    await delay(500);
  }
  t.skip('Live provider did not return within 60 seconds.');
});
