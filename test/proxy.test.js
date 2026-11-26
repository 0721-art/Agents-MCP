// The update check is the only outbound request this server makes, and behind a required
// proxy it is the difference between one-click update and a five-second timeout.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { configWith, defaults } from '../src/config.js';
import { parseProxy, proxyFetch, resolveProxy } from '../src/proxy.js';
import { checkForUpdate } from '../src/update.js';

function listening(handler) {
  return new Promise(resolve => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('a proxy address is accepted with or without its scheme', () => {
  const bare = parseProxy('127.0.0.1:7892');
  assert.equal(bare.host, '127.0.0.1:7892');
  assert.equal(bare.protocol, 'http:');
  assert.equal(parseProxy('http://127.0.0.1:7892').host, '127.0.0.1:7892');
  assert.equal(parseProxy(''), null);
  assert.throws(() => parseProxy('ftp://127.0.0.1:21'), error => error.code === 'E_PROXY');
  assert.throws(() => parseProxy('127.0.0.1'), error => error.code === 'E_PROXY');
});

test('the configured proxy wins over the environment', () => {
  const env = { HTTPS_PROXY: 'http://10.0.0.1:1111', AGENTS_MCP_PROXY: 'http://10.0.0.2:2222' };
  assert.equal(resolveProxy({ env, config: { proxy: '10.0.0.3:3333' } }).host, '10.0.0.3:3333');
  assert.equal(resolveProxy({ env }).host, '10.0.0.2:2222');
  assert.equal(resolveProxy({ env: { HTTPS_PROXY: 'http://10.0.0.1:1111' } }).host, '10.0.0.1:1111');
  assert.equal(resolveProxy({ env: {} }), null);
});

test('a plain HTTP request goes through the proxy in absolute form', async t => {
  const seen = [];
  const proxy = await listening((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, target: req.url }));
  });
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const send = proxyFetch('127.0.0.1:' + proxy.address().port);
  const response = await send('http://example.test/releases/latest', { headers: { 'user-agent': 'test' } });
  assert.equal(response.ok, true);
  assert.equal((await response.json()).target, 'http://example.test/releases/latest');
  assert.deepEqual(seen, ['http://example.test/releases/latest']);
});

test('a refused tunnel is reported as a proxy problem', async t => {
  const proxy = await listening(() => {});
  proxy.on('connect', (request, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const send = proxyFetch('127.0.0.1:' + proxy.address().port);
  await assert.rejects(send('https://api.github.com/x'), error => error.code === 'E_PROXY' && /403/.test(error.message));
});

test('a tunnel that cannot be encrypted fails as a proxy problem', { timeout: 15_000 }, async t => {
  // Speak just enough CONNECT to open the tunnel, then send something that is not TLS.
  const { createServer: createTcp } = await import('node:net');
  const sockets = new Set();
  const server = await new Promise(resolve => {
    const socketServer = createTcp(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      // Answer the CONNECT, then reply to the TLS ClientHello with something that is not TLS.
      // A proxy must not send bytes inside the CONNECT response itself, so wait for the hello.
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.once('data', () => socket.write('not a tls server\n'));
      });
    });
    socketServer.listen(0, '127.0.0.1', () => resolve(socketServer));
  });
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise(resolve => server.close(resolve));
  });
  const send = proxyFetch('127.0.0.1:' + server.address().port);
  await assert.rejects(send('https://api.github.com/x'),
    error => error.code === 'E_PROXY' && /encrypted|timed out/.test(error.message));
  void listening;
});

test('the update check reports an unreachable proxy instead of hanging', async t => {
  const result = await checkForUpdate({ stateDir: undefined, proxy: '127.0.0.1:1', fresh: true, timeoutMs: 2000 });
  assert.equal(result.newer, false);
  assert.ok(result.error, 'an error is surfaced');
  assert.equal(result.proxy, '127.0.0.1:1');
});

test('the proxy setting is validated like the rest of the config', () => {
  assert.equal(configWith(defaults, { proxy: '127.0.0.1:7892' }).proxy, '127.0.0.1:7892');
  assert.equal(configWith(defaults, { proxy: '  ' }).proxy, '');
  assert.throws(() => configWith(defaults, { proxy: 'not a proxy' }), /host:port/);
});
