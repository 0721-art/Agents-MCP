// The double-clicked executable starts the local service and opens the panel in the default
// browser. A second launch reuses the running instance instead of failing on the busy port.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { integer, problem } from './config.js';
import { stateDirectory } from './engine/store.js';
import { createHttp } from './panel/server.js';
import { createService } from './server.js';
import { installShortcuts, removeShortcuts } from './shortcut.js';
import { cleanupInstall, installPending } from './update.js';
import { serve } from './cli.js';
import { openWindow } from './window.js';

const attempts = 10;

// The packaged build is a GUI executable: it has no console, and writing to one that is not
// there throws. Progress still goes to stdout when run from a terminal.
function say(text) {
  try {
    process.stdout.write(text);
  } catch { /* no console attached */ }
}

// A panel answers /api/config with both its port and the gate settings. Plain http is used
// instead of fetch: the fetch standard refuses a list of ports (5060/5061 SIP, 6000, …) that
// a user may legitimately configure here.
function local(port, path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path, method, timeout: 3000,
      headers: body === undefined ? undefined : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

export async function isOurInstance(port) {
  try {
    const response = await local(port, '/api/config');
    if (response.status !== 200) return false;
    const config = JSON.parse(response.text);
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

// A desktop window by default; --browser keeps the old behaviour of a normal tab.
export function openPanel(url, { stateDir, browser = false }) {
  if (browser) {
    openUrl(url);
    return { mode: 'browser' };
  }
  return openWindow({ url, stateDir, open: openUrl });
}

async function listen(service, base, onShutdown, onUpdate) {
  for (let offset = 0; offset < attempts; offset++) {
    const port = base + offset;
    try {
      return await createHttp(service, { port, onShutdown, onUpdate });
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      if (await isOurInstance(port)) return { existing: port };
    }
  }
  throw problem('E_PORT', 'No free local port between ' + base + ' and ' + (base + attempts - 1) + '.');
}

export async function run(argv = process.argv.slice(2)) {
  // A previous self-update that could not swap in place left its download beside the
  // binary. Do the swap first, then hand over to the new image.
  if (installPending()) {
    spawn(process.execPath, argv, { stdio: 'ignore', detached: true, cwd: process.cwd() }).unref();
    return;
  }
  cleanupInstall();
  const { values } = parseArgs({ args: argv, options: {
    port: { type: 'string' }, 'state-dir': { type: 'string' }, 'no-open': { type: 'boolean' },
    check: { type: 'boolean' }, help: { type: 'boolean' }, stop: { type: 'boolean' },
    install: { type: 'boolean' }, startup: { type: 'boolean' }, uninstall: { type: 'boolean' },
    mcp: { type: 'string' }, selftest: { type: 'boolean' }, bridges: { type: 'boolean' }, panel: { type: 'boolean' },
    browser: { type: 'boolean' },
  } });
  // Same flags as the Node CLI, so a tool that speaks MCP to bin/agents-mcp.js can point
  // at this executable instead and needs no Node on the machine.
  if (values.mcp !== undefined || values.selftest || values.bridges) {
    await serve({
      mcp: values.mcp ?? 'stdio', port: values.port, stateDir: values['state-dir'],
      panel: Boolean(values.panel), selftest: Boolean(values.selftest),
      bridges: Boolean(values.bridges),
    });
    return;
  }
  if (values.help) {
    say('Usage: Agents-MCP [--port N] [--state-dir DIR] [--no-open] [--check]\n'
      + '       Agents-MCP --mcp=stdio|http [--panel] [--port N] [--state-dir DIR]   run as an MCP server\n'
      + '       Agents-MCP --selftest              probe every agent once and print the result\n'
      + '       Agents-MCP --bridges               show where this MCP is wired in and whether it was used\n'
      + '       Agents-MCP --install [--startup]   create Desktop and Start Menu shortcuts\n'
      + '       Agents-MCP --uninstall             remove those shortcuts\n'
      + '       Agents-MCP --stop                  stop the service running on the configured port\n'
      + '       Agents-MCP --browser               open the panel in a normal browser tab instead of its own window\n'
      + 'Starts the local service and opens the panel in its own window.\n');
    return;
  }
  if (values.check) {
    say('Agents-MCP launcher OK\n');
    return;
  }
  if (values.uninstall) {
    const removed = await removeShortcuts();
    say(removed.length ? 'Removed:\n' + removed.join('\n') + '\n' : 'No shortcut was installed.\n');
    return;
  }
  const service = await createService({ stateDir: values['state-dir'] });
  const base = values.port === undefined ? service.getConfig().port : Number(values.port);
  if (!integer(base, 0, 65535)) {
    await service.close();
    throw problem('E_CLI', 'Port must be an integer from 0 to 65535.');
  }
  if (values.install) {
    await service.close();
    const exe = process.execPath.toLowerCase().endsWith('.exe') && !process.execPath.toLowerCase().endsWith('node.exe')
      ? process.execPath : join(process.cwd(), 'dist', 'Agents-MCP.exe');
    if (!existsSync(exe)) {
      throw problem('E_SHORTCUT', 'Run npm run build:exe first, or pass the installed Agents-MCP.exe path.');
    }
    const created = await installShortcuts({ exe, startup: Boolean(values.startup) });
    say('Shortcut created:\n' + created.join('\n') + '\n');
    return;
  }
  if (values.stop) {
    await service.close();
    try {
      const response = await local(base, '/api/shutdown', { method: 'POST', body: '{}' });
      say(response.status === 200 ? 'Stopped the service on port ' + base + '.\n' : 'No service answered on port ' + base + '.\n');
      process.exitCode = response.status === 200 ? 0 : 1;
    } catch {
      say('No service is running on port ' + base + '.\n');
      process.exitCode = 1;
    }
    return;
  }
  const listener = await listen(service, base, () => {
    service.close();
    process.exit(0);
  }, async () => {
    // The binary on disk is the new one already; the running image is not. Release the
    // port, then start the replaced executable with the same arguments.
    try {
      await new Promise(resolve => {
        try {
          listener.close(resolve);
        } catch {
          resolve();
        }
      });
      await service.close();
    } catch { /* keep going: the new process takes the port either way */ }
    spawn(process.execPath, argv, { stdio: 'ignore', detached: true, cwd: process.cwd() }).unref();
    process.exit(0);
  });
  const port = listener.existing ?? listener.address().port;
  const url = 'http://127.0.0.1:' + port + '/';
  if (listener.existing) {
    await service.close();
    if (!values['no-open']) openPanel(url, { stateDir: service.getConfig().stateDir, browser: Boolean(values.browser) });
    say('Agents-MCP is already running at ' + url + '\n');
    return;
  }
  say('Agents-MCP panel at ' + url + '\n');
  if (!values['no-open']) openPanel(url, { stateDir: service.getConfig().stateDir, browser: Boolean(values.browser) });
  const close = () => Promise.all([new Promise(resolve => listener.close(resolve)), service.close()]);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.once(signal, () => close().then(() => process.exit(0), () => process.exit(1)));
  }
}

export async function reportFailure(error) {
  const message = error?.message || String(error);
  try {
    process.stderr.write('Agents-MCP: ' + message + '\n');
  } catch { /* no console attached */ }
  // A double-clicked window vanishes with its process, so keep the reason on disk as well.
  try {
    const directory = stateDirectory(undefined, process.env);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(join(directory, 'launcher.log'),
      new Date().toISOString() + ' ' + (error?.stack || message) + '\n');
  } catch { /* Nothing else can be reported. */ }
  process.exitCode = 1;
}
