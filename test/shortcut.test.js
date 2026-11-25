import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installShortcuts, removeShortcuts, runtimeExecutable, shortcutPaths, shortcutPlan } from '../src/shortcut.js';

async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agents-mcp-shortcut-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { USERPROFILE: join(dir, 'profile'), APPDATA: join(dir, 'appdata') };
  await mkdir(join(env.USERPROFILE, 'Desktop'), { recursive: true });
  await mkdir(join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), { recursive: true });
  return { dir, env };
}

test('shortcut paths come from the environment so they can be inspected', () => {
  const paths = shortcutPaths({ USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' });
  assert.equal(paths.desktop, 'C:\\Users\\me\\Desktop');
  assert.equal(paths.programs, 'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs');
  assert.equal(paths.startup, 'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup');
  assert.equal(shortcutPaths({}), null);
});

test('the plan skips folders that do not exist and adds startup only when asked', async t => {
  const { env } = await sandbox(t);
  const base = shortcutPlan({ env });
  assert.deepEqual(base.map(entry => entry.file), [
    join(env.USERPROFILE, 'Desktop', 'Agents-MCP.lnk'),
    join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Agents-MCP.lnk'),
  ]);
  const withStartup = shortcutPlan({ env, startup: true });
  assert.equal(withStartup.length, 3);
  assert.match(withStartup[2].file, /Startup[\\/]Agents-MCP\.lnk$/);
});

test('installing writes the links and uninstalling removes them', { skip: process.platform !== 'win32' }, async t => {
  const { env } = await sandbox(t);
  const exe = join(env.USERPROFILE, 'Agents-MCP.exe');
  const created = await installShortcuts({ exe, env });
  assert.equal(created.length, 2);
  for (const file of created) assert.ok(existsSync(file), file + ' should exist');
  const removed = await removeShortcuts({ env });
  assert.deepEqual(removed.sort(), created.sort());
  for (const file of created) assert.ok(!existsSync(file), file + ' should be gone');
});

test('a shortcut never points at a bare node executable', () => {
  assert.equal(runtimeExecutable({ execPath: 'E:\\Nodev\\node.exe', cwd: 'E:\\Agents-MCP' }),
    join('E:\\Agents-MCP', 'dist', 'Agents-MCP.exe'));
  assert.equal(runtimeExecutable({ execPath: 'E:\\Apps\\Agents-MCP.exe', cwd: 'E:\\Agents-MCP' }), 'E:\\Apps\\Agents-MCP.exe');
});
