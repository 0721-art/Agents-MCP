// The service entry shared by the Node CLI and the packaged executable: one place decides
// what --mcp, --panel, --selftest and --port mean, so both entry points accept the same
// flags. The launcher adds the double-click behaviour (port sweep, browser, shortcuts).
import { integer, problem } from './config.js';
import { startStdio } from './mcp/transport-stdio.js';
import { createHttp } from './panel/server.js';
import { createService } from './server.js';

export const serveOptions = {
  panel: { type: 'boolean' }, port: { type: 'string' }, selftest: { type: 'boolean' },
  mcp: { type: 'string', default: 'stdio' }, 'state-dir': { type: 'string' },
  // Accepted for parity with the packaged launcher: a CLI run never opens a browser.
  'no-open': { type: 'boolean' },
};

export async function serve({ mcp = 'stdio', port, stateDir, panel = false, selftest = false } = {}) {
  if (!['stdio', 'http'].includes(mcp)) throw problem('E_CLI', 'Expected --mcp=stdio or --mcp=http.');
  if (port !== undefined && (!/^\d+$/.test(port) || !integer(Number(port), 0, 65535))) {
    throw problem('E_CLI', 'Port must be an integer from 0 to 65535.');
  }
  const service = await createService({ stateDir });
  if (selftest) {
    const agents = service.redact(await service.listAgents({ refresh: true }));
    for (const agent of agents) {
      process.stdout.write(agent.id + ' · ' + (agent.available ? 'available' : 'unavailable')
        + ' · ' + (agent.exe || '—') + ' · ' + agent.models.length + ' models\n');
      for (const model of agent.models.slice(0, 2)) {
        process.stdout.write('  ' + model.id + ' [' + model.efforts.join(', ') + ']\n');
      }
      if (agent.reason) process.stdout.write('  ' + agent.reason + ' ' + (agent.remedy || '') + '\n');
    }
    // The update route is invisible in the agent table but decides whether 立即更新 works.
    const health = await service.health();
    const update = health.update;
    process.stdout.write('update · ' + (update.proxy
      ? update.proxy + ' via ' + update.source + ' · ' + (update.reachable ? 'reachable' : 'unreachable')
      : 'direct · no proxy configured') + '\n');
    process.stdout.write('state · ' + health.state.dir + ' · ' + (health.state.writable ? 'writable' : 'NOT writable (' + health.state.reason + ')') + '\n');
    for (const location of health.locations) {
      process.stdout.write(location.kind + ' · ' + location.dir + ' · ' + (location.writable ? 'writable' : 'NOT writable (' + location.reason + ')') + '\n');
    }
    await service.close();
    return {};
  }
  let stdio;
  let closing;
  const close = () => {
    closing ??= (async () => {
      stdio?.close();
      process.stdin.pause();
      http?.close();
      await service.close();
    })();
    return closing;
  };
  const http = panel || mcp === 'http'
    ? await createHttp(service, { port: port === undefined ? undefined : Number(port),
      onShutdown: () => close().then(() => process.exit(0), () => process.exit(1)) })
    : undefined;
  const address = http?.address();
  if (http) process.stderr.write('Agents-MCP panel at http://127.0.0.1:' + address.port + '/\n');
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  if (mcp === 'stdio') stdio = startStdio(service, { onClose: http ? undefined : () => service.close() });
  return { port: address?.port, close };
}
