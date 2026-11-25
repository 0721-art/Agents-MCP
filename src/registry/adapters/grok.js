// Verified 2026-11-25 help: --prompt-file FILE -m M --effort E --output-format json
// --permission-mode plan|acceptEdits [--resume SID]. grok models signals sign-in status.
import { join } from 'node:path';
import { adapter, failure, home, model, probeCommand, read } from './_common.js';

export default adapter({
  id: 'grok', name: 'Grok', usePromptFile: true,
  async probe({ exe, env, signal }) {
    const result = await probeCommand(exe, ['models'], env, signal);
    const output = result.stdoutTail + '\n' + result.stderrTail;
    if (/not authenticated|log.?in required/i.test(output)) return failure('Grok is not authenticated.', 'Run grok login.');
    if (result.code !== 0) return failure('grok models failed.', 'Verify the Grok installation and sign in with grok login.');
    const config = read(join(home(env), '.grok', 'config.toml'), '');
    const effort = config.match(/^\s*reasoning_effort\s*=\s*["']([a-z]+)["']/m)?.[1];
    if (!effort) return failure('Grok did not advertise per-model effort choices.', 'Set reasoning_effort in Grok before refreshing.');
    const models = [...result.stdoutTail.matchAll(/^\s*[-*]\s+([\w.-]+)/gm)].map(match => model(match[1], [effort], effort));
    return models.length ? { ok: true, models, warnings: ['Effort comes from the local Grok configuration.'] }
      : failure('Grok did not return a model catalog.', 'Check grok models.');
  },
  buildArgs({ model: name, effort, permission, promptPath, sessionId }) {
    const args = ['--prompt-file', promptPath, '-m', name, '--effort', effort, '--output-format', 'json',
      '--permission-mode', permission === 'write' ? 'acceptEdits' : 'plan'];
    if (sessionId) args.push('--resume', sessionId);
    return { args };
  },
  resumeArgs(options) { return this.buildArgs(options); },
});
