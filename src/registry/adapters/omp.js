// Research handoff verified 18.3.4: -p --model PROVIDER/ID --thinking E --mode json.
// 2026-11-25 recheck: the installed shim fails to load dist/cli.js.
import { join } from 'node:path';
import { adapter, failure, home, model, probeCommand, read } from './_common.js';
import { thinking } from './pi.js';

export function ompModels(yaml, preferred) {
  const models = [];
  let provider;
  let inModels = false;
  let entry;
  let inEfforts = false;
  function save() {
    if (!entry?.id || !provider) return;
    const efforts = entry.efforts.length ? ['off', ...entry.efforts] : entry.reasoning ? thinking : ['off'];
    models.push(model(provider + '/' + entry.id, [...new Set(efforts)], preferred, entry.name));
  }
  // Only read model metadata from the installed catalog's providers/models list.
  for (const line of yaml.split(/\r?\n/)) {
    const heading = line.match(/^ {2}([\w.-]+):\s*$/);
    if (heading) {
      save();
      provider = heading[1];
      inModels = false;
      entry = undefined;
    } else if (/^ {4}models:\s*$/.test(line)) {
      inModels = true;
    } else if (inModels && /^ {6}-\s/.test(line)) {
      save();
      entry = { efforts: [] };
      inEfforts = false;
    }
    if (!entry) continue;
    const field = line.match(/^ {6}(?:- | {2})(id|name|reasoning):\s*(.*?)\s*$/);
    if (field) {
      const [, key, value] = field;
      entry[key] = key === 'reasoning' ? value === 'true' : value.replace(/^['"]|['"]$/g, '');
    }
    if (/^ {10}\S/.test(line)) inEfforts = /^ {10}efforts:\s*$/.test(line);
    const effort = inEfforts && line.match(/^ {12}-\s+(\w+)\s*$/)?.[1];
    if (effort && thinking.includes(effort)) entry.efforts.push(effort);
  }
  save();
  return models;
}

export default adapter({
  id: 'omp', name: 'OMP',
  async probe({ env, exe, signal }) {
    const root = join(home(env), '.omp', 'agent');
    const config = read(join(root, 'config.yml'), '');
    const preferred = config.match(/^defaultThinkingLevel:\s*["']?([a-z]+)/m)?.[1];
    const models = ompModels(read(join(root, 'models.yml'), ''), preferred);
    const version = await probeCommand(exe, ['--version'], env, signal);
    if (version.code !== 0) return failure('OMP could not start.', 'Repair the omp launcher and verify omp --version.', models);
    return models.length ? { ok: true, models, version: version.stdoutTail.trim() }
      : failure('OMP did not expose a local model catalog.', 'Configure a provider in OMP models.yml.');
  },
  buildArgs({ model: name, effort, permission, prompt }) {
    const args = ['-p', '--model', name, '--thinking', effort, '--mode', 'json'];
    if (permission !== 'write') args.push('--no-tools');
    return { args, stdin: prompt };
  },
});
