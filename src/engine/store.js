import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { problem } from '../config.js';
import { createRedactor } from '../util/redact.js';

export function stateDirectory(dir, env) {
  const home = env.USERPROFILE || env.HOME || homedir();
  return resolve(dir || env.AGENTS_MCP_HOME || (process.platform === 'win32'
    ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Agents-MCP')
    : join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'agents-mcp')));
}

function parseStateJson(source, path) {
  try {
    return JSON.parse(source);
  } catch {
    throw new SyntaxError('Invalid JSON in state file ' + path);
  }
}

export async function createStore(dir, env) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const redact = createRedactor(env);
  const runDir = id => {
    if (typeof id !== 'string' || !/^\d{8}-\d{6}-[a-f0-9]{6}$/.test(id)) {
      throw problem('E_RUN_ID', 'Invalid run ID.');
    }
    return join(dir, 'runs', id);
  };
  async function readJson(path, fallback) {
    try {
      return parseStateJson(await readFile(path, 'utf8'), path);
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
  }
  async function write(path, data) {
    const temp = path + '.tmp-' + process.pid + '-' + randomBytes(6).toString('hex');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temp, data, { mode: 0o600, flag: 'wx' });
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temp, path);
          break;
        } catch (error) {
          if (attempt >= 3 || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
          await delay(25 * (attempt + 1));
        }
      }
    } finally {
      await rm(temp, { force: true });
    }
  }
  const writeJson = (path, data, options) => write(path,
    JSON.stringify(options?.redact === false ? data : redact(data), null, 2) + '\n');
  async function list(path) {
    try {
      return await readdir(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return [];
    }
  }
  return {
    dir, redact, runDir, readJson, writeJson, list,
    readState: id => readJson(join(runDir(id), 'state.json'), null),
    writeText: (path, data) => write(path, redact(data)),
    async newRun() {
      const stamp = new Date().toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '').replace('T', '-');
      const id = stamp + '-' + randomBytes(3).toString('hex');
      const root = runDir(id);
      await mkdir(join(root, 'artifacts'), { recursive: true, mode: 0o700 });
      return id;
    },
    appendEvent: (id, event) => appendFile(join(runDir(id), 'events.jsonl'), JSON.stringify(redact(event)) + '\n', { mode: 0o600 }),
    async recentEvents(id) {
      const path = join(runDir(id), 'events.jsonl');
      let handle;
      try {
        handle = await open(path, 'r');
        const { size } = await handle.stat();
        const start = Math.max(0, size - 128 * 1024);
        const buffer = Buffer.alloc(size - start);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
        return lines.slice(start ? 1 : 0, -1).slice(-40).map(line => parseStateJson(line, path));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return [];
      } finally {
        await handle?.close();
      }
    },
    async hasReport(id) {
      return stat(join(runDir(id), 'report.md')).then(info => info.isFile(), error => {
        if (error.code !== 'ENOENT') throw error;
        return false;
      });
    },
  };
}
