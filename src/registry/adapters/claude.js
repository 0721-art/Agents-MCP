// Verified 2026-11-25, 2.1.332: -p --model M --effort E --output-format stream-json
// --verbose --permission-mode plan|acceptEdits [--resume SID]; prompt on stdin.
import { join } from 'node:path';
import { adapter, failure, home, json, locate, model, probeCommand, win } from './_common.js';

export default adapter({
  id: 'claude', name: 'Claude Code',
  locate: context => locate('claude', context, [join(home(context.env), '.local', 'bin', win ? 'claude.exe' : 'claude')]),
  async probe({ exe, env, signal }) {
    const [help, version] = await Promise.all([['--help'], ['--version']].map(args => probeCommand(exe, args, env, signal)));
    const settings = json(join(env.CLAUDE_CONFIG_DIR || join(home(env), '.claude'), 'settings.json'));
    const effortText = help.stdoutTail.match(/--effort[^\r\n]*\s+\(([^)\r\n]+)\)/)?.[1];
    const efforts = effortText?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
    const aliasText = help.stdoutTail.match(/alias for the latest model\s+\(e\.g\.\s+([\s\S]*?)\)/)?.[1];
    const aliases = [...(aliasText || '').matchAll(/'([\w-]+)'/g)].map(match => match[1]);
    const models = [...new Set([settings.model, env.ANTHROPIC_MODEL, ...aliases].filter(value => typeof value === 'string' && value))]
      .map(id => model(id, efforts, settings.effortLevel));
    if (help.code !== 0 || !models.length || !efforts.length) {
      return failure('Claude CLI model aliases or effort choices could not be read.', 'Check claude --help and Claude settings.');
    }
    return { ok: true, version: version.stdoutTail.trim(), models,
      warnings: ['Model aliases and effort flags come from local CLI help. Effective effort support depends on the selected backend.'] };
  },
  buildArgs({ model: name, effort, permission, prompt, sessionId }) {
    const args = ['-p', '--model', name, '--effort', effort, '--output-format', 'stream-json', '--verbose',
      '--permission-mode', permission === 'write' ? 'acceptEdits' : 'plan'];
    if (permission !== 'write') args.push('--tools', 'Read,Glob,Grep');
    if (sessionId) args.push('--resume', sessionId);
    return { args, stdin: prompt };
  },
  resumeArgs(options) { return this.buildArgs(options); },
});
