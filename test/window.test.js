// The panel opens as its own window when a Chromium browser is around; everything else must
// still work when it is not.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { browserFor, openWindow, windowCommand, windowSize } from '../src/window.js';

const env = {
  PROGRAMFILES: 'C:\\Program Files',
  'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
};

const edge = join(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe');
const chrome = join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe');

test('edge wins over chrome, and a missing browser is reported as missing', () => {
  assert.equal(browserFor({ env, exists: path => path === edge || path === chrome }), edge);
  assert.equal(browserFor({ env, exists: path => path === chrome }), chrome);
  assert.equal(browserFor({ env, exists: () => false }), null);
});

test('the window is chromeless and keeps its own profile beside the state directory', () => {
  const { command, args } = windowCommand({ url: 'http://127.0.0.1:4870/', exe: edge, profileDir: 'C:\\state\\window-profile' });
  assert.equal(command, edge);
  assert.ok(args.includes('--app=http://127.0.0.1:4870/'));
  assert.ok(args.includes('--window-size=' + windowSize));
  assert.ok(args.includes('--user-data-dir=C:\\state\\window-profile'));
  assert.ok(args.includes('--no-first-run'));
});

test('a window is launched detached, and a machine without one falls back to the browser', async () => {
  const launched = [];
  const result = openWindow({
    url: 'http://127.0.0.1:4870/', stateDir: 'C:\\state', env,
    exists: path => path === edge,
    launch: (command, args, options) => { launched.push({ command, args, options }); return { unref() {} }; },
  });
  assert.equal(result.mode, 'window');
  assert.equal(launched.length, 1);
  assert.equal(launched[0].options.detached, true);
  assert.ok(launched[0].args.includes('--user-data-dir=' + join('C:\\state', 'window-profile')));

  const opened = [];
  const fallback = openWindow({ url: 'http://127.0.0.1:4870/', stateDir: 'C:\\state', env, exists: () => false, open: url => opened.push(url) });
  assert.equal(fallback.mode, 'browser');
  assert.deepEqual(opened, ['http://127.0.0.1:4870/']);
});
