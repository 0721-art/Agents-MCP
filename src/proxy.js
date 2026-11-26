// The update check is the only part of this server that talks to the internet, and on
// many Windows setups that traffic has to go through a local proxy. Node's fetch does not
// read the Windows proxy settings, and the user cannot be expected to export
// HTTPS_PROXY before double-clicking an exe, so the check borrows a proxy address from
// the config and opens the tunnel itself.
import { request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { Readable } from 'node:stream';
import { problem } from './config.js';

const urlLike = /^https?:\/\/[^\s/]+/i;

export function parseProxy(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = urlLike.test(value.trim()) ? value.trim() : 'http://' + value.trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw problem('E_PROXY', 'The proxy address ' + value + ' is not a URL.', 'Use the form http://127.0.0.1:7892.');
  }
  if (url.protocol !== 'http:') {
    throw problem('E_PROXY', 'Only an http:// proxy can be used, not ' + url.protocol, 'Use the mixed or HTTP port of the proxy.');
  }
  if (!url.hostname || !url.port) {
    throw problem('E_PROXY', 'The proxy address ' + value + ' needs a host and a port.', 'Use the form http://127.0.0.1:7892.');
  }
  return url;
}

export function resolveProxy({ env = process.env, config } = {}) {
  const candidate = config?.proxy || env.AGENTS_MCP_PROXY || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  return parseProxy(candidate);
}

function tunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: proxy.hostname, port: Number(proxy.port), method: 'CONNECT', path: host + ':' + port,
      headers: { host: host + ':' + port }, timeout: timeoutMs,
    });
    const fail = error => {
      request.destroy();
      reject(error);
    };
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(problem('E_PROXY', 'The proxy refused the tunnel to ' + host + ' (' + response.statusCode + ').',
          'Start the proxy, or clear the proxy field in the settings if this machine has direct access.'));
        return;
      }
      resolve(socket);
    });
    request.once('timeout', () => fail(problem('E_PROXY', 'The proxy ' + proxy.host + ':' + proxy.port + ' did not answer in time.',
      'Start the proxy, or clear the proxy field in the settings.')));
    request.once('error', error => fail(problem('E_PROXY', 'Could not reach the proxy ' + proxy.host + ':' + proxy.port + ' (' + (error.code ?? error.message) + ').',
      'Start the proxy, or clear the proxy field in the settings.')));
    request.end();
  });
}

function secureSocket(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({ socket, servername: host });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(problem('E_PROXY', 'The proxy tunnel to ' + host + ' timed out.'));
    }, timeoutMs);
    timer.unref?.();
    const done = (error) => {
      clearTimeout(timer);
      secure.removeListener('secureConnect', ok);
      if (error) { secure.destroy(); reject(error); } else resolve(secure);
    };
    const ok = () => done(null);
    secure.once('secureConnect', ok);
    secure.once('error', error => done(problem('E_PROXY', 'The tunnel to ' + host + ' could not be encrypted (' + (error.code ?? error.message) + ').')));
  });
}

function shape(response) {
  const body = () => new Promise((resolve, reject) => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve(Buffer.concat(chunks)));
    response.on('error', reject);
  });
  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    headers: response.headers,
    body: Readable.toWeb(response),
    text: async () => (await body()).toString('utf8'),
    json: async () => JSON.parse((await body()).toString('utf8')),
  };
}

// Only GET is needed: the release lookup and the asset download. Anything else fails loudly
// instead of silently going out without the tunnel.
export function proxyFetch(proxyValue, { timeoutMs = 30_000 } = {}) {
  const proxy = proxyValue instanceof URL ? proxyValue : parseProxy(proxyValue);
  if (!proxy) throw problem('E_PROXY', 'No proxy to use.');
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET') throw problem('E_PROXY', 'Only GET can go through the proxy.');
    const headers = { ...init.headers, host: url.host };
    const timeout = init.signal?.timeout ?? timeoutMs;
    let request;
    if (url.protocol === 'http:') {
      request = httpRequest({ host: proxy.hostname, port: Number(proxy.port), method, path: url.href, headers, timeout });
    } else {
      const socket = await tunnel(proxy, url.hostname, Number(url.port || 443), timeout);
      const secure = await secureSocket(socket, url.hostname, timeout);
      // An agent that hands back the socket we already opened: node then skips both the
      // DNS lookup and its own TLS handshake, which cannot succeed inside this network.
      const whileOpen = new HttpsAgent({ keepAlive: false, maxSockets: 1 });
      whileOpen.createConnection = () => secure;
      request = httpsRequest({
        host: url.hostname, port: Number(url.port || 443), method, path: url.pathname + url.search,
        headers, timeout, agent: whileOpen,
      });
    }
    return new Promise((resolve, reject) => {
      request.once('response', response => resolve(shape(response)));
      request.once('timeout', () => {
        request.destroy();
        reject(problem('E_PROXY', 'The request to ' + url.host + ' timed out through the proxy.'));
      });
      request.once('error', error => reject(problem('E_PROXY', 'The request to ' + url.host + ' failed (' + (error.code ?? error.message) + ').')));
      request.end();
    });
  };
}
