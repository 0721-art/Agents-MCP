// Tells the panel when a newer release exists, and installs it: a git checkout pulls, the
// packaged exe downloads the release binary and replaces itself on restart.
//
// The check is one unauthenticated request to the GitHub releases API, cached for six
// hours in the state directory, so a panel that stays open costs nothing.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, rmSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';

export const repository = '0721-art/Agents-MCP';
export const releasesUrl = 'https://github.com/' + repository + '/releases/latest';
const cacheTtlMs = 6 * 60 * 60 * 1000;
export const executableAsset = 'Agents-MCP.exe';

// The version of the running code: baked in at build time for the exe, read from
// package.json for a checkout.
export const version = (() => {
  const baked = process.env.AGENTS_MCP_VERSION;
  if (typeof baked === 'string' && /^\d+\.\d+\.\d+/.test(baked)) return baked;
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

export const checkoutRoot = (() => {
  try {
    return fileURLToPath(new URL('..', import.meta.url));
  } catch {
    return process.cwd();
  }
})();

// Inside the packaged exe there is no checkout to update: the bundle has no
// import.meta.url, so checkoutRoot falls back to the working directory, which may well
// hold an unrelated .git. A packaged binary updates by replacing itself instead.
export const packaged = (() => {
  try {
    return isSea();
  } catch {
    return false;
  }
})();

export function parseVersion(value) {
  const match = String(value ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

const cachePath = stateDir => join(stateDir, 'update-check.json');

function readCache(stateDir) {
  if (!stateDir) return null;
  try {
    const value = JSON.parse(readFileSync(cachePath(stateDir), 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function writeCache(stateDir, value) {
  try {
    writeFileSync(cachePath(stateDir), JSON.stringify(value, null, 2) + '\n');
  } catch {
    // A read-only state directory must not break the panel.
  }
}

// The download URL and digest of the release's executable, when that release ships one.
function pickAsset(body) {
  const assets = Array.isArray(body?.assets) ? body.assets : [];
  const match = assets.find(asset => asset?.name === executableAsset);
  if (!match || typeof match.browser_download_url !== 'string') return null;
  return {
    name: match.name,
    url: match.browser_download_url,
    size: Number.isFinite(match.size) ? match.size : null,
    digest: typeof match.digest === 'string' ? match.digest : null,
  };
}

const checkout = () => !packaged && existsSync(join(checkoutRoot, '.git'));

const describe = (current, record, extra = {}) => ({
  current,
  latest: record.latest ?? null,
  newer: record.latest ? isNewer(record.latest, current) : false,
  url: record.url || releasesUrl,
  publishedAt: record.publishedAt ?? null,
  notes: typeof record.notes === 'string' ? record.notes.slice(0, 1200) : null,
  checkedAt: record.checkedAt ?? null,
  checkout: checkout(),
  packaged,
  // One click is only offered when this copy demonstrably knows how to install the update.
  canSelfUpdate: packaged ? Boolean(record.asset) : checkout(),
  asset: record.asset ?? null,
  ...extra,
});

export async function checkForUpdate({
  stateDir, env = process.env, current = version, now = Date.now(), fetchImpl = fetch, timeoutMs = 5000, fresh = false,
} = {}) {
  const cached = stateDir ? readCache(stateDir) : null;
  if (env.AGENTS_MCP_NO_UPDATE_CHECK) return describe(current, cached ?? {}, { disabled: true });
  if (!fresh && cached && now - (cached.checkedAt ?? 0) < cacheTtlMs) return describe(current, cached, { cached: true });
  try {
    const response = await fetchImpl('https://api.github.com/repos/' + repository + '/releases/latest', {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'agents-mcp/' + current },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error('GitHub returned ' + response.status);
    const body = await response.json();
    const record = {
      latest: typeof body.tag_name === 'string' ? body.tag_name : null,
      url: typeof body.html_url === 'string' ? body.html_url : releasesUrl,
      publishedAt: typeof body.published_at === 'string' ? body.published_at : null,
      notes: typeof body.body === 'string' ? body.body.slice(0, 1200) : null,
      checkedAt: now,
      asset: pickAsset(body),
    };
    if (stateDir) writeCache(stateDir, record);
    return describe(current, record);
  } catch (error) {
    return describe(current, cached ?? {}, { error: error?.message ?? 'update check failed' });
  }
}

function pullCheckout({ env, root }) {
  const steps = [['git', ['-C', root, 'pull', '--ff-only']], ['npm', ['install', '--no-audit', '--no-fund']]];
  const output = [];
  for (const [command, args] of steps) {
    const result = spawnSync(command, args, { encoding: 'utf8', cwd: root, env, shell: process.platform === 'win32' });
    output.push('$ ' + command + ' ' + args.join(' ') + '\n' + ((result.stdout ?? '') + (result.stderr ?? '')).trim());
    if (result.status !== 0) {
      const error = new Error('Update stopped at `' + command + ' ' + args.join(' ') + '`:\n' + ((result.stdout ?? '') + (result.stderr ?? '')).trim());
      error.code = 'E_UPDATE';
      throw error;
    }
  }
  return { ok: true, output: output.join('\n\n'), restart: 'Restart the service to run the new version.' };
}

function fail(code, message, remedy) {
  const error = new Error(message + (remedy ? '\n' + remedy : ''));
  error.code = code;
  throw error;
}

// Downloads the release executable beside the running one, checks it, then swaps it in.
// Windows refuses to overwrite a running image but allows renaming it, so the running
// file becomes `.old` and the fresh download takes its name. When even that is refused
// (an install folder the user cannot write), the download is kept as `.new` and the
// swap is retried on the next start.
export async function replaceExecutable({ stateDir, env = process.env, fetchImpl = fetch, target = process.execPath, timeoutMs = 300_000 } = {}) {
  if (!target.toLowerCase().endsWith('.exe')) fail('E_NOT_PACKAGED', 'Only the packaged executable can replace itself.');
  const record = readCache(stateDir);
  const asset = record?.asset;
  if (!asset?.url) {
    fail('E_NO_ASSET', 'The latest release does not ship ' + executableAsset + '.',
      'Download the release page asset and replace the file by hand.');
  }
  const staging = target + '.new';
  const backup = target + '.old';
  let response;
  try {
    response = await fetchImpl(asset.url, {
      headers: { 'user-agent': 'agents-mcp/' + (record?.latest ?? version) },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    fail('E_DOWNLOAD', 'Could not download the new release: ' + (error?.message ?? 'network error'),
      'Check the network or proxy, then try again. The release page still has the file.');
  }
  if (!response.ok || !response.body) fail('E_DOWNLOAD', 'The download returned HTTP ' + response.status + '.');
  const hash = createHash('sha256');
  try {
    await pipeline(Readable.fromWeb(response.body), async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk);
        yield chunk;
      }
    }, createWriteStream(staging, { mode: 0o755 }));
  } catch (error) {
    rmSync(staging, { force: true });
    fail('E_DOWNLOAD', 'The download stopped early: ' + (error?.message ?? 'unknown error'));
  }
  const size = existsSync(staging) ? statSync(staging).size : 0;
  if (asset.size && size !== asset.size) {
    rmSync(staging, { force: true });
    fail('E_DOWNLOAD', 'The downloaded file is ' + size + ' bytes, expected ' + asset.size + '.');
  }
  if (asset.digest?.startsWith('sha256:')) {
    const actual = 'sha256:' + hash.digest('hex');
    if (actual !== asset.digest.toLowerCase()) {
      rmSync(staging, { force: true });
      fail('E_DOWNLOAD', 'The downloaded file failed its checksum check.');
    }
  }
  const bytes = 'Downloaded ' + size + ' bytes.';
  try {
    swap(target, staging, backup);
  } catch (error) {
    // The download is good but the folder refuses the swap; the next start retries it.
    return {
      ok: true, restarting: false, pending: true, version: record?.latest ?? null, path: target,
      output: bytes,
      restart: 'Saved the new version as ' + staging + '. Close Agents-MCP and start it again; '
        + 'the swap happens on the next launch (' + (error?.message ?? 'rename refused') + ').',
    };
  }
  return { ok: true, restarting: true, version: record?.latest ?? null, path: target, output: bytes,
    restart: 'The new version starts automatically.' };
}

function swap(target, staging, backup) {
  rmSync(backup, { force: true });
  renameSync(target, backup);
  try {
    renameSync(staging, target);
  } catch (error) {
    try { renameSync(backup, target); } catch { /* the backup stays beside the binary */ }
    throw error;
  }
}

// A swap that failed last time is retried before the service claims the port, so the
// second launch of a read-only install folder still ends up on the new version.
export function installPending({ target = process.execPath } = {}) {
  const staging = target + '.new';
  if (!existsSync(staging)) return false;
  try {
    swap(target, staging, target + '.old');
    return true;
  } catch {
    return false;
  }
}

// Removes the leftovers of a previous self-update. The running image is gone from the
// directory, so `.old` is only ever a stale copy.
export function cleanupInstall({ target = process.execPath } = {}) {
  for (const suffix of ['.download', '.old']) {
    try {
      rmSync(target + suffix, { force: true });
    } catch { /* still mapped by a running process */ }
  }
}

export async function applyUpdate({ stateDir, env = process.env, root = checkoutRoot, fetchImpl = fetch, ...rest } = {}) {
  if (packaged) return replaceExecutable({ stateDir, env, fetchImpl, ...rest });
  if (!existsSync(join(root, '.git'))) {
    fail('E_NOT_CHECKOUT', 'This copy was not installed from a git checkout, so it cannot update itself.',
      'Download the new release instead.');
  }
  return pullCheckout({ env, root });
}
