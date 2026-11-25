import { randomUUID } from 'node:crypto';
import { createProtocol, rpcError, versions } from './protocol.js';

export function mcpHttp(service, readJson, sendJson) {
  const protocol = createProtocol(service);
  const sessions = new Map();
  return async (req, res) => {
    const sid = req.headers['mcp-session-id'];
    const version = req.headers['mcp-protocol-version'];
    if (version && !versions.includes(version)) return sendJson(res, 400, { code: 'E_PROTOCOL_VERSION' });
    if (req.method === 'GET') {
      res.setHeader('Allow', 'POST, DELETE');
      res.writeHead(405).end();
      return;
    }
    if (sid && !sessions.has(sid)) return sendJson(res, 404, { code: 'E_SESSION' });
    if (sid && version && sessions.get(sid) !== version) return sendJson(res, 400, { code: 'E_PROTOCOL_VERSION' });
    if (req.method === 'DELETE' && sid) {
      sessions.delete(sid);
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, DELETE');
      res.writeHead(405).end();
      return;
    }
    let message;
    try {
      message = await readJson(req);
    } catch (error) {
      if (error.code === 'E_JSON') return sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
      throw error;
    }
    if (message?.method !== 'initialize' && !sid && message?.jsonrpc === '2.0' && typeof message.method === 'string') {
      return sendJson(res, 400, rpcError(message.id ?? null, -32600, 'Mcp-Session-Id is required'));
    }
    const stream = message?.method === 'tools/call' && message?.id !== undefined
      && /\btext\/event-stream\b/.test(req.headers.accept || '');
    if (stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = event => { if (event && !res.destroyed) res.write('event: message\ndata: ' + JSON.stringify(event) + '\n\n'); };
      send(await protocol(message, send, sid));
      res.end();
      return;
    }
    const response = await protocol(message, undefined, sid);
    if (!response) return res.writeHead(202).end();
    if (message?.method === 'initialize' && response.result) {
      const id = randomUUID();
      sessions.set(id, response.result.protocolVersion);
      res.setHeader('Mcp-Session-Id', id);
    }
    sendJson(res, 200, response);
  };
}
