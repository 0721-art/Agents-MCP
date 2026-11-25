// Tells the panel when a newer release exists, and — for a git checkout — pulls it.
//
// The check is one unauthenticated request to the GitHub releases API, cached for six
// hours in the state directory, so a panel that stays open costs nothing. A packaged
// exe cannot replace itself while it runs, so there the panel only offers the release
// page; only a checkout can be updated in place.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';

export const repository = '0721-art/Agents-MCP';
export const releasesUrl = 'https://github.com/' + repository + '/releases/latest';
const cacheTtlMs = 6 * 60 * 60 * 1000;

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
// hold an unrelated .git. Never offer an in-place pull from there.
const packaged = (() => {
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

const describe = (current, record, extra = {}) => ({
  current,
  latest: record.latest ?? null,
  newer: record.latest ? isNewer(record.latest, current) : false,
  url: record.url || releasesUrl,
  publishedAt: record.publishedAt ?? null,
  notes: typeof record.notes === 'string' ? record.notes.slice(0, 1200) : null,
  checkedAt: record.checkedAt ?? null,
  checkout: !packaged && existsSync(join(checkoutRoot, '.git')),
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
    };
    if (stateDir) writeCache(stateDir, record);
    return describe(current, record);
  } catch (error) {
    return describe(current, cached ?? {}, { error: error?.message ?? 'update check failed' });
  }
}

// Only a git checkout can be updated in place; the packaged exe points at its release page.
export function applyUpdate({ env = process.env, root = checkoutRoot } = {}) {
  const gitDir = join(root, '.git');
  if (packaged || !existsSync(gitDir)) {
    const error = new Error('This copy was not installed from a git checkout, so it cannot update itself. '
      + 'Download the new release instead.');
    error.code = 'E_NOT_CHECKOUT';
    throw error;
  }
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
