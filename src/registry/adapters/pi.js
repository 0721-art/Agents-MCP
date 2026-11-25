// Verified 2026-11-25: -p --model PROVIDER/ID --thinking E --mode json
// [--session-id UUID] [--no-mcp --no-extensions --tools read,grep,find,ls].
import { join } from 'node:path';
import { adapter, failure, home, json, model, probeCommand } from './_common.js';

export const thinking = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function piModels(data, saved, preferred) {
  const models = new Map();
  for (const { providers = {} } of [saved, data]) {
    for (const [provider, config] of Object.entries(providers)) {
      for (const entry of config.models ?? []) {
        if (typeof entry.id !== 'string') continue;
        const id = provider + '/' + entry.id;
        const levels = entry.thinkingLevels ?? Object.keys(entry.thinkingLevelMap ?? {});
        const efforts = [...new Set(['off', ...levels.filter(level => thinking.includes(level))])];
        const supported = efforts.length > 1 || !entry.reasoning ? efforts : thinking;
        models.set(id, model(id, supported, preferred, entry.name));
      }
    }
  }
  return [...models.values()];
}

export default adapter({
  id: 'pi', name: 'Pi',
  async probe({ env, exe, signal }) {
    const root = env.PI_CODING_AGENT_DIR || join(home(env), '.pi', 'agent');
    const settings = json(join(root, 'settings.json'));
    const models = piModels(json(join(root, 'models.json')), json(join(root, 'models-store.json')), settings.defaultThinkingLevel);
    const version = await probeCommand(exe, ['--version'], env, signal);
    if (version.code !== 0) return failure('Pi failed to start.', 'Check Pi installation and access to its agent directory.', models);
    return models.length ? { ok: true, models, version: version.stdoutTail.trim() }
      : failure('Pi did not expose locally configured models.', 'Configure a model in Pi models.json.');
  },
  buildArgs({ model: name, effort, permission, prompt, sessionId }) {
    const args = ['-p', '--model', name, '--thinking', effort, '--mode', 'json'];
    if (permission !== 'write') args.push('--no-mcp', '--no-extensions', '--tools', 'read,grep,find,ls');
    if (sessionId) args.push('--session-id', sessionId);
    return { args, stdin: prompt };
  },
  resumeArgs(options) { return this.buildArgs(options); },
});
