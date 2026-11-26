#!/usr/bin/env node
// Node entry point: identical flags to the packaged executable (see src/cli.js).
import { parseArgs } from 'node:util';
import { serve, serveOptions } from '../src/cli.js';

const usage = 'Usage: agents-mcp [--panel] [--mcp=stdio|http] [--port N] [--state-dir DIR] [--selftest]\n';

try {
  const { values } = parseArgs({ options: { ...serveOptions, help: { type: 'boolean' } } });
  if (values.help) {
    process.stdout.write(usage);
  } else {
    await serve({
      mcp: values.mcp, port: values.port, stateDir: values['state-dir'],
      panel: Boolean(values.panel), selftest: Boolean(values.selftest),
    });
  }
} catch (error) {
  process.stderr.write('Agents-MCP: ' + error.message + '\n');
  process.exitCode = 1;
}
