// Verified 2026-11-25 against @deepseek-ai/dsh 0.2.2-rc.5 (npm bin `dsh`):
//   dsh --profile headless --dump-config            composed profile tree
//   dsh --patch OVERLAY --profile headless --json --permission-mode MODE --approval-policy never -
// Headless exposes no --model/--effort flags; the per-run overlay patches the entry
// `agent-default-model` ({provider, model, reasoningEffort?}, see --dump-config-schema),
// and --dump-config confirms the overlay wins over the profile layer.
// The headless profile keeps no model catalog of its own, so the probe reports the
// profile default model only, plus a health note when the credential is missing.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapter, failure, home, locate, model, probeCommand, win } from './_common.js';

// DeepSeek routes map these effort names (reasoningEfforts in a DSH provider entry).
const deepseekEfforts = ['off', 'low', 'high', 'max'];

export function parseDump(text) {
  let inside = false;
  let provider;
  let id;
  for (const line of text.split(/\r?\n/)) {
    const entry = /^-\s+id:\s*(\S+)\s*$/.exec(line);
    if (entry) {
      inside = entry[1] === 'agent-default-model';
      continue;
    }
    if (!inside) continue;
    const field = /^\s+(provider|model):\s*(\S+)\s*$/.exec(line);
    if (!field) continue;
    const value = field[2].replace(/^['"]|['"]$/g, '');
    if (field[1] === 'provider') provider = value; else id = value;
  }
  return provider && id ? { provider, model: id } : null;
}

export function overlay(provider, id, effort) {
  const lines = ['- id: agent-default-model', '  config:', '    provider: ' + provider, '    model: ' + id];
  if (effort) lines.push('    reasoningEffort: ' + effort);
  return lines.join('\n') + '\n';
}

export default adapter({
  id: 'dsh', name: 'DeepSeek Harness',
  locate: context => locate('dsh', context, win && !context.overrides.exe
    ? [join(context.env.APPDATA || join(home(context.env), 'AppData', 'Roaming'), 'npm', 'dsh.cmd')]
    : []),
  async probe({ exe, env, signal }) {
    const dump = await probeCommand(exe, ['--profile', 'headless', '--dump-config'], env, signal);
    if (dump.code !== 0) {
      return failure('The DSH launcher did not compose the headless profile.',
        'Install @deepseek-ai/dsh globally (npm i -g @deepseek-ai/dsh) or set its executable override.');
    }
    const current = parseDump(dump.stdoutTail);
    if (!current) {
      return failure('The headless profile has no agent-default-model entry.',
        'Add @deepseek-ai/dsh-agent-default-model to the headless profile patch.');
    }
    const warnings = [];
    if (/^deepseek/.test(current.provider) && !env.DEEPSEEK_API_KEY) {
      warnings.push('The headless profile ignores the desktop sign-in: export DEEPSEEK_API_KEY before running DSH tasks.');
    }
    return {
      ok: true,
      version: 'headless profile default',
      warnings,
      models: [model(current.provider + '/' + current.model,
        deepseekEfforts.includes('high') && /^deepseek/.test(current.provider) ? deepseekEfforts : ['default'],
        'high', current.provider + '/' + current.model)],
    };
  },
  buildArgs({ model: name, effort, permission, prompt, sessionId }) {
    const cut = name.indexOf('/');
    const provider = cut > 0 ? name.slice(0, cut) : 'deepseek-official';
    const id = cut > 0 ? name.slice(cut + 1) : name;
    const dir = mkdtempSync(join(tmpdir(), 'agents-mcp-dsh-'));
    const patch = join(dir, 'overlay.yml');
    const cleanup = () => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    try {
      writeFileSync(patch, overlay(provider, id, effort && effort !== 'default' ? effort : null));
    } catch (error) {
      cleanup();
      throw error;
    }
    const args = ['--patch', patch, '--profile', 'headless', '--json',
      '--permission-mode', permission === 'write' ? 'workspace-write' : 'read-only',
      '--approval-policy', 'never'];
    if (sessionId) args.push('--session-id', sessionId);
    return { args: [...args, '-'], stdin: prompt, cleanup };
  },
  resumeArgs(options) { return this.buildArgs(options); },
});
