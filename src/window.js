// The panel is a desktop window, not a browser tab: Edge and Chrome both host a chromeless
// app window, which is enough here and keeps the runtime free of extra dependencies. A
// dedicated profile directory means the window keeps its own size and never disturbs the
// browser session the user is already in.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const windowSize = '1360,900';

const candidates = env => [
  join(env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(env.PROGRAMFILES ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(env.LOCALAPPDATA ?? 'C:\\Users\\Public', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(env.LOCALAPPDATA ?? 'C:\\Users\\Public', 'Google', 'Chrome', 'Application', 'chrome.exe'),
];

export function browserFor({ env = process.env, exists = existsSync } = {}) {
  return candidates(env).find(path => path && exists(path)) ?? null;
}

// --app= drops the tabs, address bar and menu; --no-first-run keeps a fresh profile from
// opening a welcome page on top of the panel.
export function windowCommand({ url, exe, profileDir }) {
  return {
    command: exe,
    args: [
      '--app=' + url,
      '--window-size=' + windowSize,
      '--user-data-dir=' + profileDir,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
    ],
  };
}

export function openWindow({ url, stateDir, env = process.env, exists = existsSync, launch = spawn, open } = {}) {
  const exe = process.platform === 'win32' ? browserFor({ env, exists }) : null;
  if (!exe) {
    open?.(url);
    return { mode: 'browser' };
  }
  const { command, args } = windowCommand({ url, exe, profileDir: join(stateDir, 'window-profile') });
  launch(command, args, { stdio: 'ignore', detached: true, windowsHide: false }).unref();
  return { mode: 'window', exe };
}
