import { accessSync, constants, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { run } from '../../runner/exec.js';
import { jsonEvent } from '../../runner/events.js';

export const home = env => env.USERPROFILE || env.HOME || homedir();
export const localApp = env => join(home(env), 'AppData', 'Local');
export const win = process.platform === 'win32';

export function locate(name, { overrides, env }, paths = []) {
  if (overrides.exe) {
    const exe = resolve(overrides.exe);
    return existsSync(exe) ? { exe, source: 'override' } : null;
  }
  for (const exe of paths) if (exe && existsSync(exe)) return { exe, source: 'install' };
  const suffixes = win ? ['.exe', '.cmd', '.bat'] : [''];
  for (const path of (env.PATH || env.Path || '').split(delimiter)) {
    if (!path) continue;
    for (const suffix of suffixes) {
      const exe = resolve(path.replace(/^"|"$/g, ''), name + suffix);
      try {
        accessSync(exe, constants.X_OK);
        return { exe, source: 'PATH' };
      } catch {
        // Try the next executable.
      }
    }
  }
  return null;
}

export function read(path, fallback) {
  try {
    return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return fallback;
  }
}

export const json = (path, fallback = {}) => JSON.parse(read(path, JSON.stringify(fallback)));
export const model = (id, efforts, defaultEffort, label = id) => ({
  id, label, efforts, defaultEffort: efforts.includes(defaultEffort) ? defaultEffort : efforts[0],
});
export const probeCommand = (exe, args, env, signal) => run({ exe, args, env, signal, timeoutMs: 12_000 });
export const failure = (reason, remedy, models = []) => ({ ok: false, reason, remedy, models });
export function adapter(spec) {
  return {
    kind: 'cli', locate: context => locate(spec.id, context), parseStream: jsonEvent,
    parseSessionId: event => event.sessionId, env: () => ({}), ...spec,
  };
}
