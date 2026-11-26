// Verified 2026-11-25, 1.5.16 help: --model ID --mode plan|accept-edits
// --input-format stream-json --output-format stream-json [--json-schema FILE] [--resume ID];
// catalog via models. The prompt travels over stdin as one stream-json user event because
// Windows argv stops accepting arguments at 32 KiB, and tasks are allowed to be far longer.
import { join } from 'node:path';
import { adapter, failure, localApp, locate, model, probeCommand, win } from './_common.js';

export function parseModels(text) {
  const models = [];
  const seen = new Set();
  for (const line of text.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const id = line.match(/^\s*(?:[-*•│]\s*)?([a-z][a-z0-9._]*-[a-z0-9._-]+)(?=$|[\s│|:(])/i)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const effort = id.match(/-(low|medium|high|xhigh|max)$/)?.[1];
    models.push(model(id, effort ? [effort] : ['default'], effort));
  }
  return models;
}

const sessionIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export function parseStream(line) {
  const event = JSON.parse(line);
  const candidate = event.conversation_id ?? event.result?.conversation_id;
  const sessionId = typeof candidate === 'string' && sessionIdPattern.test(candidate) ? candidate : undefined;
  if (event.event === 'result') {
    const status = event.result?.status;
    return {
      type: status === 'SUCCESS' ? 'result' : 'error',
      text: event.result?.response || event.result?.error?.message || status || 'Antigravity returned no answer.',
      sessionId,
    };
  }
  if (event.event === 'step_update') {
    const update = event.step_update ?? {};
    const usage = update.usage ? {
      ...(Number.isFinite(update.usage.input_tokens) && { inputTokens: update.usage.input_tokens }),
      ...(Number.isFinite(update.usage.output_tokens) && { outputTokens: update.usage.output_tokens }),
      ...(Number.isFinite(update.usage.thinking_tokens) && { reasoningTokens: update.usage.thinking_tokens }),
    } : undefined;
    const attached = usage && Object.keys(usage).length ? { usage } : {};
    const thought = update.text_delta ?? update.text;
    if ((update.step_type === 'thought' || update.step_type === 'thinking') && typeof thought === 'string') {
      return { type: 'reasoning', text: thought, sessionId, ...(update.text_delta ? { delta: true } : {}), ...attached };
    }
    if (update.step_type === 'agent_response' && typeof update.text_delta === 'string' && update.text_delta) {
      // The closing DONE chunk carries the last answer fragment together with the usage counts.
      return { type: 'assistant', text: update.text_delta, sessionId, ...attached };
    }
    // Antigravity reports thinking tokens without the thinking text, so keep the count visible.
    return { type: 'raw', data: { type: 'step_update', step: update.step_type, state: update.state }, sessionId, ...attached };
  }
  if (event.event === 'error') return { type: 'error', text: event.error?.message ?? event.error, sessionId };
  return { type: 'raw', data: { type: event.event }, sessionId };
}

export default adapter({
  id: 'agy', name: 'Antigravity', supportsSchema: true, parseStream,
  locate: context => locate('agy', context, win
    ? [join(context.env.LOCALAPPDATA || localApp(context.env), 'agy', 'bin', 'agy.exe'),
      join(localApp(context.env), 'agy', 'bin', 'agy.exe')] : []),
  // A missing catalog has three very different causes; naming them saves a support round.
  async probe({ exe, env, signal }) {
    const [listing, version] = await Promise.all([
      probeCommand(exe, ['models'], env, signal), probeCommand(exe, ['--version'], env, signal),
    ]);
    const models = parseModels(listing.stdoutTail);
    if (listing.code !== 0 || !models.length) {
      const output = listing.stdoutTail + '\n' + listing.stderrTail;
      const detail = (output.split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop() ?? '').slice(0, 200);
      const suffix = detail ? ' (' + detail + ')' : '';
      if (/timed out|timeout|ETIMEDOUT/i.test(output)) {
        return { ...failure('Antigravity timed out while fetching its model list' + suffix + '.',
          'Check the Antigravity proxy (HTTP_PROXY / HTTPS_PROXY override) and the network, then refresh.'), version: version.stdoutTail.trim() };
      }
      if (/sign in|not logged|login|unauthor/i.test(output)) {
        return { ...failure('Antigravity model catalog needs a signed-in CLI' + suffix + '.',
          'Run "agy login" in a normal terminal, then refresh.'), version: version.stdoutTail.trim() };
      }
      if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network|proxy|fetch failed|5\d\d\b/i.test(output)) {
        return { ...failure('Antigravity could not reach its service' + suffix + '.',
          'A proxy or the network is in the way: set HTTP_PROXY / HTTPS_PROXY below, then refresh.'), version: version.stdoutTail.trim() };
      }
      return { ...failure('agy models returned no usable catalog' + suffix + '.',
        'Run "agy models" in a terminal to see the full error, then refresh.'), version: version.stdoutTail.trim() };
    }
    return { ok: true, models, version: version.stdoutTail.trim(),
      warnings: models.some(entry => entry.defaultEffort === 'default') ? ['Unqualified model IDs use the CLI default effort.'] : [] };
  },
  buildArgs({ model: name, permission, prompt, schemaPath, sessionId }) {
    const args = ['--model', name, '--mode', permission === 'write' ? 'accept-edits' : 'plan',
      '--input-format', 'stream-json', '--output-format', 'stream-json'];
    if (schemaPath) args.push('--json-schema', schemaPath);
    if (sessionId && sessionIdPattern.test(sessionId)) args.push('--resume', sessionId);
    return { args, stdin: JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n' };
  },
  resumeArgs(options) { return this.buildArgs(options); },
});
