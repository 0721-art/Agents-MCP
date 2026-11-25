// The double-clicked executable starts the local service and opens the panel in the default
// browser. A second launch reuses the running instance instead of failing on the busy port.
import { spawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { integer, problem } from './config.js';
import { stateDirectory } from './engine/store.js';
import { createHttp } from './panel/server.js';
import { createService } from './server.js';

const attempts = 10;

// A panel answers /api/config with both its port and the gate settings.
export async function isOurInstance(port) {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/api/config', { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    const config = await response.json();
    return Number.isInteger(config?.port) && typeof config?.gate === 'object';
  } catch {
    return false;
  }
}

export function openUrl(url) {
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
}

async function listen(service, base) {
  for (let offset = 0; offset < attempts; offset++) {
    const port = base + offset;
    try {
      return await createHttp(service, { port });
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      if (await isOurInstance(port)) return { existing: port };
    }
  }
  throw problem('E_PORT', 'No free local port between ' + base + ' and ' + (base + attempts - 1) + '.');
}

export async function run(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    port: { type: 'string' }, 'state-dir': { type: 'string' }, 'no-open': { type: 'boolean' },
    check: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    process.stdout.write('Usage: Agents-MCP [--port N] [--state-dir DIR] [--no-open] [--check]\n'
      + 'Starts the local panel and opens it in the default browser. Close this window to stop it.\n');
    return;
  }
  if (values.check) {
    process.stdout.write('Agents-MCP launcher OK\n');
    return;
  }
  const service = await createService({ stateDir: values['state-dir'] });
  const base = values.port === undefined ? service.getConfig().port : Number(values.port);
  if (!integer(base, 0, 65535)) {
    await service.close();
    throw problem('E_CLI', 'Port must be an integer from 0 to 65535.');
  }
  const listener = await listen(service, base);
  const port = listener.existing ?? listener.address().port;
  const url = 'http://127.0.0.1:' + port + '/';
  if (listener.existing) {
    await service.close();
    if (!values['no-open']) openUrl(url);
    process.stdout.write('Agents-MCP is already running at ' + url + '\n');
    return;
  }
  process.stdout.write('Agents-MCP panel at ' + url + '\nClose this window to stop the service.\n');
  if (!values['no-open']) openUrl(url);
  const close = () => Promise.all([new Promise(resolve => listener.close(resolve)), service.close()]);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.once(signal, () => close().then(() => process.exit(0), () => process.exit(1)));
  }
}

export async function reportFailure(error) {
  const message = error?.message || String(error);
  process.stderr.write('Agents-MCP: ' + message + '\n');
  // A double-clicked window vanishes with its process, so keep the reason on disk as well.
  try {
    const directory = stateDirectory(undefined, process.env);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(join(directory, 'launcher.log'),
      new Date().toISOString() + ' ' + (error?.stack || message) + '\n');
  } catch { /* Nothing else can be reported. */ }
  process.exitCode = 1;
}
