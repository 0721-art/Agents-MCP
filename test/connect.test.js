// The connect script only orchestrates other CLIs, so the parts worth pinning down are its
// argument handling and the guarantee that it never guesses a target.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/connect.mjs', import.meta.url));

const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('the usage text lists every supported agent', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  for (const name of ['codex', 'claude', 'dsh']) assert.match(stdout, new RegExp('\\b' + name + '\\b'));
  assert.match(stdout, /--remove/);
  assert.match(stdout, /--approve/);
});

test('a missing or unknown target fails without touching anything', () => {
  const missing = run([]);
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /Usage: connect/);

  const unknown = run(['cursor']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown target "cursor"/);
});
