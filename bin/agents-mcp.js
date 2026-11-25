#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { integer, problem } from '../src/config.js';
import { startStdio } from '../src/mcp/transport-stdio.js';
import { createHttp } from '../src/panel/server.js';
import { createService } from '../src/server.js';

async function main() {
  const { values } = parseArgs({ options: {
    panel: { type: 'boolean' }, port: { type: 'string' }, selftest: { type: 'boolean' },
    mcp: { type: 'string', default: 'stdio' }, 'state-dir': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    process.stdout.write('Usage: agents-mcp [--panel] [--mcp=stdio|http] [--port N] [--state-dir DIR] [--selftest]\n');
    return;
  }
  if (!['stdio', 'http'].includes(values.mcp)) throw problem('E_CLI', 'Expected --mcp=stdio or --mcp=http.');
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!/^\d+$/.test(values.port) || !integer(port, 0, 65535))) {
    throw problem('E_CLI', 'Port must be an integer from 0 to 65535.');
  }
  const service = await createService({ stateDir: values['state-dir'] });
  if (values.selftest) {
    const agents = service.redact(await service.listAgents({ refresh: true }));
    for (const agent of agents) {
      process.stdout.write(agent.id + ' · ' + (agent.available ? 'available' : 'unavailable')
        + ' · ' + (agent.exe || '—') + ' · ' + agent.models.length + ' models\n');
      for (const model of agent.models.slice(0, 2)) {
        process.stdout.write('  ' + model.id + ' [' + model.efforts.join(', ') + ']\n');
      }
      if (agent.reason) process.stdout.write('  ' + agent.reason + ' ' + (agent.remedy || '') + '\n');
    }
    return;
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
  const http = values.panel || values.mcp === 'http'
    ? await createHttp(service, { port, onShutdown: () => close().then(() => process.exit(0), () => process.exit(1)) })
    : undefined;
  if (http) process.stderr.write('Agents-MCP panel at http://127.0.0.1:' + http.address().port + '/\n');
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  if (values.mcp === 'stdio') stdio = startStdio(service, { onClose: http ? undefined : () => service.close() });
}

try {
  await main();
} catch (error) {
  process.stderr.write('Agents-MCP: ' + error.message + '\n');
  process.exitCode = 1;
}
