// Desktop and Start Menu shortcuts for the packaged executable, so a download can be
// installed without opening a terminal. Windows only; other platforms get an empty plan.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { problem } from './config.js';

// Folder locations come from the environment, not from PowerShell, so the plan can be
// inspected (and tested) without touching the real shell folders.
export function shortcutPaths(env = process.env) {
  const profile = env.USERPROFILE || env.HOME;
  const appData = env.APPDATA;
  if (!profile || !appData) return null;
  const programs = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  return { desktop: join(profile, 'Desktop'), programs, startup: join(programs, 'Startup') };
}

export function shortcutPlan({ env = process.env, startup = false } = {}) {
  const paths = shortcutPaths(env);
  if (!paths) return [];
  const wanted = [{ directory: paths.desktop }, { directory: paths.programs }];
  if (startup) wanted.push({ directory: paths.startup });
  return wanted.filter(entry => existsSync(entry.directory))
    .map(entry => ({ directory: entry.directory, file: join(entry.directory, 'Agents-MCP.lnk') }));
}

const quote = value => "'" + String(value).replaceAll("'", "''") + "'";

// The executable a shortcut should point at: the native panel window when it sits beside the
// running service, else the packaged exe, else the built one next to the checkout.
export function runtimeExecutable({ execPath = process.execPath, cwd = process.cwd(), exists = existsSync } = {}) {
  const panel = join(dirname(execPath), 'Agents-MCP.Panel.exe');
  if (exists(panel)) return panel;
  const base = execPath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (base !== 'node.exe' && base !== 'node') return execPath;
  return join(cwd, 'dist', 'desktop', exists(join(cwd, 'dist', 'desktop', 'Agents-MCP.exe')) ? 'Agents-MCP.Panel.exe' : '..\\Agents-MCP.exe');
}

// The failing folder and the reason matter more than the stack PowerShell prints: a shortcut
// that cannot be written is almost always a permissions problem, not a broken install.
function shortcutFailure(entry, result) {
  const raw = ((result.stderr ?? '') + (result.stdout ?? '')).trim();
  const reason = raw
    ? (/UnauthorizedAccess|Access is denied|拒绝访问/i.test(raw) ? 'no permission to write this folder'
      : raw.split(/\r?\n/).filter(Boolean).pop())
    : 'powershell produced no output';
  const error = new Error('Could not create the shortcut ' + entry.file + ': ' + reason);
  error.code = 'E_SHORTCUT';
  error.remedy = /permission|denied|拒绝访问/i.test(raw)
    ? 'The folder ' + entry.directory + ' is read-only for this account. Run Agents-MCP from a normal '
      + 'desktop session, or create the shortcut by hand (right-click Agents-MCP.exe → 发送到 → 桌面快捷方式).'
    : 'The executable still works; create the shortcut by hand if you need one.';
  throw error;
}

function powershell(script, entry) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  if (result.status !== 0) shortcutFailure(entry, result);
}

export async function installShortcuts({ exe, env = process.env, startup = false } = {}) {
  if (!exe) throw problem('E_SHORTCUT', 'No executable to point the shortcut at.');
  const plan = shortcutPlan({ env, startup });
  if (!plan.length) throw problem('E_SHORTCUT', 'Found no Desktop or Start Menu folder to install into.',
    'Set USERPROFILE/APPDATA, or create the shortcut by hand.');
  for (const entry of plan) {
    powershell('$s = (New-Object -ComObject WScript.Shell).CreateShortcut(' + quote(entry.file) + ');'
      + '$s.TargetPath = ' + quote(exe) + ';'
      + '$s.WorkingDirectory = ' + quote(dirname(exe)) + ';'
      + '$s.IconLocation = ' + quote(exe + ',0') + ';'
      + '$s.Description = ' + quote('Agents-MCP 控制台') + ';'
      + '$s.Save()', entry);
  }
  return plan.map(entry => entry.file);
}

export async function removeShortcuts({ env = process.env } = {}) {
  const plan = shortcutPlan({ env, startup: true });
  const removed = [];
  for (const entry of plan) {
    if (!existsSync(entry.file)) continue;
    await rm(entry.file, { force: true });
    if (!existsSync(entry.file)) removed.push(entry.file);
  }
  return removed;
}
