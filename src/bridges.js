// "Is it actually on?" is the question people ask in the middle of using the thing, not
// while reading docs. These rows answer it from two sides: what each client's config says,
// and whether that client has really connected and called a tool recently.
import { readFile, rename, writeFile } from 'node:fs/promises';
import { problem } from './config.js';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const serverName = 'agents-mcp';

// Toggles edit the client's own file, so write to a sibling and rename: a half-written
// config.toml or ~/.claude.json would break the client, not just this panel.
async function atomicWrite(path, body) {
  const staging = path + '.tmp-' + process.pid;
  await writeFile(staging, body);
  await rename(staging, path);
}

function codexSection(config) {
  return config.match(/\[mcp_servers\.["']?agents-mcp["']?\]([\s\S]*?)(?=\n\[|$)/);
}

async function toggleCodex({ path, enabled }) {
  const config = await text(path);
  const section = codexSection(config);
  if (!section) {
    throw problem('E_NOT_CONFIGURED', 'Codex has no [mcp_servers.agents-mcp] table in ' + path + '.',
      'Register it first: node scripts/connect.mjs codex');
  }
  const body = section[1];
  const stripped = body.replace(/^[ \t]*enabled[ \t]*=[ \t]*(?:false|true)[ \t]*\r?\n/gm, '');
  const next = enabled ? stripped : stripped + 'enabled = false\n';
  const updated = config.slice(0, section.index) + section[0].replace(body, next) + config.slice(section.index + section[0].length);
  await atomicWrite(path, updated);
}

async function toggleClaude({ path, stateDir, enabled, launch }) {
  const raw = await text(path);
  let parsed;
  try {
    parsed = JSON.parse(raw || '{}');
  } catch {
    throw problem('E_NOT_CONFIGURED', 'Cannot read ' + path + ' as JSON.', 'Fix or delete that file, then retry.');
  }
  parsed.mcpServers = parsed.mcpServers ?? {};
  const stashPath = join(stateDir, 'claude-bridge.json');
  if (!enabled) {
    const entry = parsed.mcpServers[serverName];
    if (!entry) {
      throw problem('E_NOT_CONFIGURED', 'Claude Code has no ' + serverName + ' server in ' + path + '.',
        'Register it first: node scripts/connect.mjs claude');
    }
    await writeFile(stashPath, JSON.stringify(entry));
    delete parsed.mcpServers[serverName];
  } else {
    if (parsed.mcpServers[serverName]) return;
    let entry = null;
    try {
      entry = JSON.parse(await text(stashPath));
    } catch {
      entry = null;
    }
    parsed.mcpServers[serverName] = entry ?? launch();
  }
  await atomicWrite(path, JSON.stringify(parsed, null, 2) + '\n');
}

async function toggleDsh({ file, enabled }) {
  const lines = (await text(file)).split('\n');
  const start = lines.findIndex(line => /^(\s*)-\s*id:\s*agents-mcp-bridge\s*$/.test(line));
  if (start < 0) {
    throw problem('E_NOT_CONFIGURED', 'The DSH bundle at ' + file + ' has no agents-mcp-bridge row.',
      'Reinstall the bundle: node scripts/connect.mjs dsh');
  }
  const indent = lines[start].match(/^(\s*)/)[1];
  let stop = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const item = lines[index].match(/^(\s*)-\s/);
    if (item && item[1].length <= indent.length) { stop = index; break; }
  }
  const body = lines.slice(start + 1, stop).filter(line => !/^\s*disabled:\s*true\s*$/.test(line));
  if (!enabled) body.push(indent + '  disabled: true');
  await atomicWrite(file, [...lines.slice(0, start + 1), ...body, ...lines.slice(stop)].join('\n'));
}

// One switch per client, implemented with that client's own mechanism.
export async function setBridge({ id, enabled, env = process.env, home = homedir(), stateDir, launch } = {}) {
  const userHome = env.USERPROFILE || home;
  if (id === 'codex') {
    await toggleCodex({ path: join(userHome, '.codex', 'config.toml'), enabled });
  } else if (id === 'claude') {
    await toggleClaude({ path: join(userHome, '.claude.json'), stateDir, enabled, launch });
  } else if (id === 'dsh') {
    const file = await dshBundleFile({ env, home });
    if (!file) {
      throw problem('E_NOT_CONFIGURED', 'DSH has no agents-mcp bundle installed.',
        'Install it first: node scripts/connect.mjs dsh');
    }
    await toggleDsh({ file, enabled });
  } else {
    throw problem('E_UNKNOWN_CLIENT', 'Unknown client "' + id + '".', 'Use codex, claude, or dsh.');
  }
}

async function dshBundleFile({ env = process.env, home = homedir() }) {
  const userHome = env.USERPROFILE || home;
  for (const name of ['desktop', 'headless', 'web']) {
    const dir = join(userHome, '.dsh', 'profiles', name);
    if (!existsSync(dir)) continue;
    let bundles = [];
    try {
      bundles = JSON.parse(await text(join(dir, 'package.json')))?.dsh?.profile?.bundles ?? [];
    } catch {
      bundles = [];
    }
    for (const bundle of bundles.filter(entry => /agents-mcp/i.test(entry))) {
      const file = join(dir, 'node_modules', bundle, 'cordis.patch.yml');
      if (existsSync(file)) return file;
    }
  }
  return null;
}

async function text(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function codexRow(config) {
  const section = config.match(/\[mcp_servers\.["']?agents-mcp["']?\]([\s\S]*?)(?=\n\[|$)/);
  if (!section) return { configured: false, enabled: null, detail: '未写入 ~/.codex/config.toml' };
  const disabled = /\benabled\s*=\s*false/i.test(section[1]);
  const approve = /default_tools_approval_mode\s*=\s*["']approve["']/i.test(section[1]);
  return {
    configured: true, enabled: !disabled,
    detail: disabled ? '配置存在但 enabled = false' : approve ? '已注册，工具免确认' : '已注册；首次调用需要确认',
  };
}

function claudeRow(config) {
  let parsed;
  try {
    parsed = JSON.parse(config);
  } catch {
    return { configured: false, enabled: null, detail: '读不到 ~/.claude.json' };
  }
  const entry = parsed?.mcpServers?.[serverName];
  if (!entry) return { configured: false, enabled: null, detail: '未写入用户级 MCP 配置' };
  return { configured: true, enabled: true, detail: entry.type === 'http' ? 'HTTP 传输' : 'stdio 传输' };
}

function dshRow(profiles) {
  const hit = profiles.find(profile => profile.text);
  if (!hit) return { configured: false, enabled: null, detail: 'DSH 配置里没有这个 MCP' };
  const disabled = /\bdisabled:\s*true/.test(hit.text);
  return {
    configured: true, enabled: !disabled,
    detail: (disabled ? '插件已安装但被禁用' : '已作为插件安装') + '（' + hit.profile + '）',
  };
}

export function describeRow(history, base) {
  const seen = history?.[base.id];
  return {
    ...base,
    lastSeen: seen?.lastSeen ?? null,
    connectedNow: false,
    calls: seen?.calls ?? 0,
  };
}

// The files are small; the whole check is a handful of reads.
export async function clientBridges({ env = process.env, home = homedir() } = {}) {
  const userHome = env.USERPROFILE || home;
  const codex = codexRow(await text(join(userHome, '.codex', 'config.toml')));
  const claude = claudeRow(await text(join(userHome, '.claude.json')));
  // DSH installs through bundles: the profile lists a bundle name and the bundle itself
  // carries the MCP row, so both places have to be read to answer "is it on".
  const dshHome = join(userHome, '.dsh', 'profiles');
  const profiles = [];
  for (const name of ['desktop', 'headless', 'web']) {
    const dir = join(dshHome, name);
    if (!existsSync(dir)) continue;
    const patch = await text(join(dir, 'cordis.patch.yml'));
    const candidates = [];
    if (/agents-mcp-bridge|serverName:\s*agents-mcp/.test(patch)) candidates.push(patch);
    let bundles = [];
    try {
      bundles = JSON.parse(await text(join(dir, 'package.json')))?.dsh?.profile?.bundles ?? [];
    } catch {
      bundles = [];
    }
    for (const bundle of bundles.filter(entry => /agents-mcp/i.test(entry))) {
      candidates.push(await text(join(dir, 'node_modules', bundle, 'cordis.patch.yml')) || 'agents-mcp');
    }
    if (candidates.length) profiles.push({ profile: name, text: candidates.join('\n') });
  }
  const dsh = dshRow(profiles);
  return [
    describeRow(null, { id: 'codex', label: 'Codex CLI', config: join(userHome, '.codex', 'config.toml'), ...codex }),
    describeRow(null, { id: 'claude', label: 'Claude Code', config: join(userHome, '.claude.json'), ...claude }),
    describeRow(null, { id: 'dsh', label: 'DeepSeek Harness', config: dshHome, ...dsh }),
  ];
}

// Which client just connected? initialize carries clientInfo.name, and the names are free
// text, so match loosely and keep an "other" bucket rather than dropping strangers.
export function usageId(name = '') {
  const value = String(name).toLowerCase();
  if (value.includes('codex')) return 'codex';
  if (value.includes('claude')) return 'claude';
  if (value.includes('dsh') || value.includes('deepseek')) return 'dsh';
  return 'other';
}

export async function readHistory(stateDir) {
  try {
    return JSON.parse(await readFile(join(stateDir, 'bridges.json'), 'utf8'));
  } catch {
    return {};
  }
}

export function createUsage(stateDir, { writeFile } = {}) {
  const history = {};
  let loaded;
  const persist = async () => {
    if (!writeFile) return;
    try {
      await writeFile(join(stateDir, 'bridges.json'), JSON.stringify(history));
    } catch {
      // A read-only state directory must not break tool calls.
    }
  };
  const load = async () => {
    loaded = loaded ?? readHistory(stateDir).then(saved => Object.assign(history, saved));
    return loaded;
  };
  return {
    load,
    note: async info => {
      await load();
      const id = usageId(info?.name);
      history[id] = { ...(history[id] ?? { calls: 0 }), name: info?.name ?? 'unknown', lastSeen: new Date().toISOString() };
      await persist();
    },
    // The last client that introduced itself owns the calls that follow it.
    noteCall: async () => {
      await load();
      const entry = Object.entries(history)
        .filter(([, value]) => value.lastSeen)
        .sort(([, a], [, b]) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))[0];
      const key = entry?.[0] ?? 'other';
      const current = history[key] ?? {};
      history[key] = { ...current, lastSeen: new Date().toISOString(), calls: (current.calls ?? 0) + 1 };
      await persist();
    },
    snapshot: () => history,
  };
}
