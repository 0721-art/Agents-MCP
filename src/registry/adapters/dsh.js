// Verified 2026-11-25 against @deepseek-ai/dsh 0.2.2-rc.5 (npm bin `dsh`):
//   dsh --profile headless --dump-config            composed profile tree
//   dsh --patch OVERLAY --profile headless --json --permission-mode MODE --approval-policy never -
// Headless exposes no --model/--effort flags; the per-run overlay patches the entry
// `agent-default-model` ({provider, model, reasoningEffort?}, see --dump-config-schema),
// and --dump-config confirms the overlay wins over the profile layer.
// The headless profile ships no model catalog, but the desktop profile's patch layer
// usually configures @deepseek-ai/dsh-llm-pi-ai providers (`new`, `global`, ...). The
// probe reads those providers from the profile patches so the panel offers the models
// the user actually configured; the overlay copies the selected provider verbatim.
// Headless ignores the managed credential store, so the apiKeyEnv each provider names is
// resolved from the environment first and then from ~/.dsh/.credentials.yaml, which is
// where the DSH Models page stores it.
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapter, failure, home, locate, model, probeCommand, read, win } from './_common.js';
import { jsonEvent } from '../../runner/events.js';

// The headless app streams its own NDJSON vocabulary on top of the shared shapes:
//   {"type":"thinking","text":…}     reasoning, already understood by jsonEvent
//   {"type":"text","text":…}         answer chunks
//   {"type":"final","text":…}        the turn's final answer
//   {"type":"status","phase":"turn_end","reason":{…}}  turn outcome, including errors
export function parseStream(line) {
  const event = JSON.parse(line);
  if (event.type === 'text' && typeof event.text === 'string') {
    return { type: 'assistant', text: event.text, sessionId: event.sessionId };
  }
  if (event.type === 'final') {
    if (event.reason?.kind === 'error') {
      return { type: 'error', text: event.reason.error?.message ?? String(event.reason.error), sessionId: event.sessionId };
    }
    return { type: 'result', text: event.text ?? '', sessionId: event.sessionId };
  }
  if (event.type === 'status' && event.phase === 'turn_end' && event.reason?.kind === 'error') {
    return { type: 'error', text: event.reason.error?.message ?? String(event.reason.error), sessionId: event.sessionId };
  }
  return jsonEvent(line);
}

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

const unquote = value => value.replace(/^['"]|['"]$/g, '');

// Reads the providers of one profile patch: every `- id: llm-pi-ai` entry may carry a
// `config.providers` map, and each provider keeps its YAML lines so an overlay can copy it.
export function parseProviders(text) {
  const lines = text.split(/\r?\n/);
  const providers = [];
  for (let start = 0; start < lines.length; start += 1) {
    if (!/^-\s+id:\s*llm-pi-ai\s*$/.test(lines[start])) continue;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) if (/^-\s+id:/.test(lines[i])) { end = i; break; }
    const block = lines.slice(start, end);
    const head = block.findIndex(line => /^\s+providers:\s*$/.test(line));
    if (head < 0) continue;
    const providerIndent = /^\s*/.exec(block[head])[0].length + 2;
    let current;
    let modelIndent = -1;
    let effortsIndent = -1;
    for (let i = head + 1; i < block.length; i += 1) {
      const line = block[i];
      if (!line.trim()) continue;
      const indent = /^\s*/.exec(line)[0].length;
      if (indent < providerIndent) break;
      if (indent === providerIndent) {
        const name = /^\s*([\w.-]+):\s*$/.exec(line);
        if (name) {
          current = { name: name[1], apiKeyEnv: null, models: [], lines: [] };
          providers.push(current);
          modelIndent = -1;
          effortsIndent = -1;
          continue;
        }
      }
      if (!current) continue;
      current.lines.push(line);
      const key = /^\s+apiKeyEnv:\s*(\S+)\s*$/.exec(line);
      if (key) current.apiKeyEnv = unquote(key[1]);
      const modelLine = /^(\s*)-\s+id:\s*(\S+)\s*$/.exec(line);
      if (modelLine) {
        modelIndent = modelLine[1].length;
        effortsIndent = -1;
        current.models.push({ id: unquote(modelLine[2]), name: unquote(modelLine[2]), efforts: [] });
        continue;
      }
      const entry = current.models[current.models.length - 1];
      if (!entry) continue;
      if (/^\s+reasoningEfforts:\s*$/.test(line)) {
        effortsIndent = indent;
        continue;
      }
      if (effortsIndent >= 0 && indent > effortsIndent) {
        const effort = /^\s*([\w-]+)\s*:/.exec(line);
        if (effort) entry.efforts.push(effort[1]);
        continue;
      }
      effortsIndent = -1;
      if (indent === modelIndent + 2) {
        const label = /^\s*name:\s*(.+?)\s*$/.exec(line);
        if (label) entry.name = unquote(label[1]);
      }
    }
  }
  return providers;
}

export function profilePatches(env) {
  const root = join(home(env), '.dsh', 'profiles');
  let names = [];
  try {
    names = readdirSync(root).filter(name => {
      try {
        return statSync(join(root, name, 'cordis.patch.yml')).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
  // The desktop profile is the one the user configures; the others rarely carry providers.
  names.sort((a, b) => (a === 'desktop' ? -1 : b === 'desktop' ? 1 : a.localeCompare(b)));
  return names.map(name => ({ name, path: join(root, name, 'cordis.patch.yml') }));
}

export function discoverProviders(env) {
  const found = new Map();
  for (const { name, path } of profilePatches(env)) {
    for (const provider of parseProviders(read(path, ''))) {
      if (!found.has(provider.name)) found.set(provider.name, { ...provider, profile: name });
    }
  }
  return [...found.values()];
}

// ~/.dsh/.credentials.yaml keeps the apiKeyEnv values under `refs:` (name → secret).
export function readCredentials(env) {
  const text = read(join(home(env), '.dsh', '.credentials.yaml'), '');
  const refs = {};
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inside = true; continue; }
    if (!inside) continue;
    if (/^\S/.test(line)) { inside = false; continue; }
    const entry = /^\s+([\w.-]+):\s*(.+?)\s*$/.exec(line);
    if (entry) refs[entry[1]] = unquote(entry[2]);
  }
  return refs;
}

const effortsOf = entry => (entry.efforts.length ? [...new Set(entry.efforts)] : ['default']);
const defaultEffort = efforts => (efforts.includes('high') ? 'high' : efforts[0]);

export function overlay(provider, id, effort, providerLines = []) {
  const head = providerLines.length
    ? ['- id: llm-pi-ai', '  name: "@deepseek-ai/dsh-llm-pi-ai"', '  config:', '    providers:', '      ' + provider + ':', ...providerLines]
    : ['- id: llm-pi-ai', '  name: "@deepseek-ai/dsh-llm-pi-ai"', '  config:', '    providers:', '      ' + provider + ': {}'];
  const tail = ['- id: agent-default-model', '  config:', '    provider: ' + provider, '    model: "' + id + '"'];
  if (effort) tail.push('    reasoningEffort: ' + effort);
  return [...head, ...tail].join('\n') + '\n';
}

export default adapter({
  id: 'dsh', name: 'DeepSeek Harness',
  parseStream,
  locate: context => locate('dsh', context, win && !context.overrides.exe
    ? [join(context.env.APPDATA || join(home(context.env), 'AppData', 'Roaming'), 'npm', 'dsh.cmd')]
    : []),
  async probe({ exe, env, signal }) {
    const providers = discoverProviders(env);
    if (providers.length) {
      const credentials = readCredentials(env);
      const warnings = [];
      const models = [];
      for (const provider of providers) {
        const missing = provider.apiKeyEnv && !env[provider.apiKeyEnv] && !credentials[provider.apiKeyEnv];
        if (missing) {
          warnings.push(provider.name + ' needs ' + provider.apiKeyEnv
            + ': store it on the DSH Models page, export it, or set it in this panel.');
        }
        if (!provider.models.length) {
          models.push(model(provider.name + '/default', ['default'], 'default', provider.name + ' (profile default)'));
          continue;
        }
        for (const entry of provider.models) {
          const efforts = effortsOf(entry);
          const id = provider.name + '/' + entry.id;
          models.push(model(id, efforts, defaultEffort(efforts), entry.name + ' · ' + provider.name));
        }
      }
      return { ok: true, version: 'profiles: ' + [...new Set(providers.map(p => p.profile))].join(', '), warnings, models };
    }
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
  buildArgs({ model: name, effort, permission, prompt, sessionId, env = process.env }) {
    const cut = name.indexOf('/');
    const provider = cut > 0 ? name.slice(0, cut) : 'deepseek-official';
    const id = cut > 0 ? name.slice(cut + 1) : name;
    const providerLines = discoverProviders(env).find(entry => entry.name === provider)?.lines ?? [];
    const dir = mkdtempSync(join(tmpdir(), 'agents-mcp-dsh-'));
    const patch = join(dir, 'overlay.yml');
    const cleanup = () => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    try {
      writeFileSync(patch, overlay(provider, id, effort && effort !== 'default' ? effort : null, providerLines));
    } catch (error) {
      cleanup();
      throw error;
    }
    // Headless disables the managed store, so hand it the key the provider names.
    const keyEnv = discoverProviders(env).find(entry => entry.name === provider)?.apiKeyEnv;
    const secret = keyEnv ? env[keyEnv] ?? readCredentials(env)[keyEnv] : null;
    const childEnv = keyEnv && secret ? { [keyEnv]: secret } : {};
    const args = ['--patch', patch, '--profile', 'headless', '--json',
      '--permission-mode', permission === 'write' ? 'workspace-write' : 'read-only',
      '--approval-policy', 'never'];
    if (sessionId) args.push('--session-id', sessionId);
    return { args: [...args, '-'], stdin: prompt, env: childEnv, cleanup };
  },
  resumeArgs(options) { return this.buildArgs(options); },
});
