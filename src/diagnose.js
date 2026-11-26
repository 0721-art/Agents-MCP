// The official problem report was dominated by one theme: people could not tell why
// something failed. This module answers the questions the panel and --selftest need to
// show: where state really lives and whether it is writable, which folders shortcuts can
// reach, and whether the update route has any chance of working.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { proxySource } from './proxy.js';
import { shortcutPaths } from './shortcut.js';
import { version } from './update.js';

async function canWrite(dir) {
  try {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, '.write-test-' + process.pid + '-' + Date.now().toString(16));
    await writeFile(probe, 'ok', { flag: 'wx' });
    await rm(probe, { force: true });
    return { writable: true };
  } catch (error) {
    return { writable: false, reason: error.code ?? error.message };
  }
}

function reachable(proxy, timeoutMs) {
  return new Promise(resolve => {
    const socket = connect({ host: proxy.hostname, port: Number(proxy.port) });
    const finish = value => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

// Everything here is a fact about this machine, not a guess: each field is probed now.
export async function environmentReport({ env = process.env, stateDir, proxy = '', timeoutMs = 1500 } = {}) {
  const { value, source, proxy: parsed } = proxySource({ env, config: { proxy } });
  const paths = shortcutPaths(env);
  const locations = [];
  for (const key of ['desktop', 'programs']) {
    const dir = paths?.[key];
    if (!dir) continue;
    locations.push({ kind: key, dir, ...(await canWrite(dir)) });
  }
  return {
    version,
    node: process.version,
    platform: process.platform,
    state: { dir: stateDir, ...(await canWrite(stateDir)) },
    locations,
    update: {
      proxy: value,
      source,
      reachable: parsed ? await reachable(parsed, timeoutMs) : null,
    },
  };
}
