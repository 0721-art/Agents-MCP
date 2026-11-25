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
    if (update.state === 'ACTIVE' && update.text_delta) return { type: 'assistant', text: update.text_delta, sessionId };
    return { type: 'raw', data: { type: 'step_update', step: update.step_type, state: update.state }, sessionId };
  }
  if (event.event === 'error') return { type: 'error', text: event.error?.message ?? event.error, sessionId };
  return { type: 'raw', data: { type: event.event }, sessionId };
}

export default adapter({
  id: 'agy', name: 'Antigravity', supportsSchema: true, parseStream,
  locate: context => locate('agy', context, win
    ? [join(context.env.LOCALAPPDATA || localApp(context.env), 'agy', 'bin', 'agy.exe'),
      join(localApp(context.env), 'agy', 'bin', 'agy.exe')] : []),
  async probe({ exe, env, signal }) {
    const [listing, version] = await Promise.all([
      probeCommand(exe, ['models'], env, signal), probeCommand(exe, ['--version'], env, signal),
    ]);
    const models = parseModels(listing.stdoutTail);
    if (listing.code !== 0 || !models.length) {
      const auth = /sign in|not logged/i.test(listing.stdoutTail + listing.stderrTail);
      return { ...failure(auth ? 'Antigravity model catalog needs a signed-in CLI.' : 'agy models returned no usable catalog.',
        'Sign in to agy, check the proxy override, then refresh.'), version: version.stdoutTail.trim() };
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
