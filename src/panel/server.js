import { createServer } from 'node:http';
import { problem } from '../config.js';
import { readPanelFile } from '../assets.js';
import { errorInfo } from '../mcp/protocol.js';
import { mcpHttp } from '../mcp/transport-http.js';

const staticFiles = {
  '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'],
  '/panel.js': ['panel.js', 'text/javascript'], '/panel.css': ['panel.css', 'text/css'],
};
const maxBody = 1024 * 1024;
const jsonType = /^application\/json(?:\s*;|$)/i;

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  if (!jsonType.test(req.headers['content-type'] || '')) throw problem('E_CONTENT_TYPE', 'Use Content-Type: application/json.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBody) {
      req.resume();
      throw problem('E_SIZE', 'Request body exceeds 1 MiB.');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw problem('E_JSON', 'Invalid JSON body.');
  }
}

export async function createHttp(service, { port = service.getConfig().port } = {}) {
  const mcp = mcpHttp(service, readJson, sendJson);
  let expectedPort;
  const server = createServer(async (req, res) => {
    try {
      res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const host = req.headers.host;
      const origin = req.headers.origin;
      const local = host === '127.0.0.1:' + expectedPort || host === 'localhost:' + expectedPort
        || (expectedPort === 80 && ['localhost', '127.0.0.1'].includes(host));
      if (!local || (origin && origin !== 'http://' + host)) {
        return sendJson(res, 403, { code: 'E_ORIGIN', message: 'Only the local server origin is allowed.' });
      }
      const url = new URL(req.url, 'http://' + host);
      const path = url.pathname;
      const method = req.method;
      if (path === '/mcp') return await mcp(req, res);
      if (method === 'GET' && Object.hasOwn(staticFiles, path)) {
        const [file, type] = staticFiles[path];
        const content = await readPanelFile(file);
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }).end(content);
        return;
      }
      const value = async () => {
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem('E_INPUT', 'Expected an object.');
        return body;
      };
      const operations = {
        'GET /api/agents': () => service.listAgents({ refresh: url.searchParams.get('refresh') === '1' }),
        'GET /api/config': service.getConfig,
        'PUT /api/config': async () => service.setConfig(await value()),
        'GET /api/strengths': () => service.getConfig().strengths,
        'PUT /api/strengths': async () => (await service.setConfig({ strengths: await value() })).strengths,
        'GET /api/gate/pending': service.pending,
        'POST /api/gate': async () => service.gate(await value()),
        'POST /api/flow/validate': async () => service.planFlow(await value()),
        'POST /api/flow/run': async () => service.runFlow(await value()),
        'POST /api/delegate': async () => service.delegate(await value()),
        'POST /api/draft-role': async () => service.draftRole(await value()),
        'GET /api/runs': service.listRuns,
      };
      const route = method + ' ' + path;
      if (Object.hasOwn(operations, route)) {
        const data = await operations[route]();
        const gateReply = route === 'GET /api/gate/pending' || Object.hasOwn(data, 'taskId');
        return sendJson(res, 200, gateReply ? data : service.redact(data));
      }
      const override = path.match(/^\/api\/agents\/([\w-]+)\/override$/);
      if (method === 'PUT' && override) return sendJson(res, 200, service.redact(await service.override(override[1], await value())));
      const run = path.match(/^\/api\/runs\/([\w-]+)(?:\/(cancel|files\/(.+)))?$/);
      if (run) {
        const [, runId, action, file] = run;
        if (method === 'GET' && !action) return sendJson(res, 200, service.redact(await service.status({ runId })));
        if (method === 'POST' && action === 'cancel') {
          await value();
          return sendJson(res, 200, service.redact(await service.cancel({ runId })));
        }
        if (method === 'GET' && file) {
          const content = await service.runFile(runId, decodeURIComponent(file));
          return res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(content);
        }
      }
      sendJson(res, 404, { code: 'E_ROUTE', message: 'Route not found.' });
    } catch (error) {
      try {
        if (res.headersSent) return res.end();
        const info = errorInfo(error);
        const status = { E_CONTENT_TYPE: 415, E_SIZE: 413, E_RUN_NOT_FOUND: 404, E_FILE: 404 }[info.code]
          ?? ((typeof error?.code === 'string' && error.code.startsWith('E_')) || error instanceof URIError ? 400 : 500);
        sendJson(res, status, service.redact(info));
      } catch {
        res.destroy();
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      expectedPort = server.address().port;
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}
