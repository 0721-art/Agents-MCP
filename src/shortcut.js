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

// The executable a shortcut should point at: the packaged exe when running from it, otherwise
// the built one next to the checkout.
export function runtimeExecutable({ execPath = process.execPath, cwd = process.cwd() } = {}) {
  const base = execPath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (base !== 'node.exe' && base !== 'node') return execPath;
  return join(cwd, 'dist', 'Agents-MCP.exe');
}

function powershell(script) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    const reason = (result.stderr || result.stdout || 'powershell failed').trim().split(/\r?\n/).pop();
    throw problem('E_SHORTCUT', 'Could not create the shortcut: ' + reason);
  }
}

export async function installShortcuts({ exe, env = process.env, startup = false } = {}) {
  if (!exe) throw problem('E_SHORTCUT', 'No executable to point the shortcut at.');
  const plan = shortcutPlan({ env, startup });
  if (!plan.length) throw problem('E_SHORTCUT', 'Found no Desktop or Start Menu folder to install into.');
  for (const entry of plan) {
    powershell('$s = (New-Object -ComObject WScript.Shell).CreateShortcut(' + quote(entry.file) + ');'
      + '$s.TargetPath = ' + quote(exe) + ';'
      + '$s.WorkingDirectory = ' + quote(dirname(exe)) + ';'
      + '$s.IconLocation = ' + quote(exe + ',0') + ';'
      + '$s.Description = ' + quote('Agents-MCP 控制台') + ';'
      + '$s.Save()');
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
