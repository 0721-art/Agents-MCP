import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { problem } from '../config.js';
import { run } from '../runner/exec.js';

// FolderBrowserDialog needs an STA thread and Windows PowerShell 5.1 ships with every supported
// Windows, so the picker does not depend on pwsh 7 being on PATH. The chosen path goes through a
// file because a redirected PowerShell console mangles non-ASCII paths.
const quote = value => "'" + String(value).replace(/'/g, "''") + "'";

export function folderScript(output, initial) {
  return [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = '选择 Agent 的工作目录'",
    '$dialog.ShowNewFolderButton = $true',
    initial ? '$dialog.SelectedPath = ' + quote(initial) : '',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [System.IO.File]::WriteAllText(' + quote(output) + ', $dialog.SelectedPath, [System.Text.Encoding]::UTF8)',
    '}',
  ].filter(Boolean).join('\r\n');
}

export async function pickFolder({ initial, env = process.env, timeoutMs = 240_000 } = {}) {
  if (process.platform !== 'win32') {
    throw problem('E_PICKER', 'The folder picker is only available on Windows.', 'Type the directory path instead.');
  }
  const dir = mkdtempSync(join(tmpdir(), 'agents-mcp-picker-'));
  const output = join(dir, 'choice.txt');
  const exe = join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const result = await run({
      exe, args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', folderScript(output, initial)], env, timeoutMs,
    });
    if (result.cancelled) return { cancelled: true };
    if (result.code !== 0) {
      throw problem('E_PICKER', 'The folder picker could not open.', (result.stderrTail || '').trim().slice(0, 400) || undefined);
    }
    let chosen = '';
    try {
      chosen = readFileSync(output, 'utf8').trim();
    } catch {
      chosen = '';
    }
    return chosen ? { path: chosen } : { cancelled: true };
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}
