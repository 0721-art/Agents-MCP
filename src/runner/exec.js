import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { problem } from '../config.js';

const limit = 256 * 1024;

// npm shims re-exec node by name. Inside the packaged single-file executable process.execPath is
// Agents-MCP.exe, which rejects the shim's script argument, so shims get a real node instead.
export function nodeRuntime(env = process.env, execPath = process.execPath) {
  if (/^node(?:\.exe)?$/i.test(basename(execPath))) return execPath;
  const path = env.PATH ?? env.Path ?? '';
  const candidates = [env.npm_node_execpath, ...path.split(delimiter).filter(Boolean).map(dir => join(dir, 'node.exe'))];
  return candidates.find(candidate => typeof candidate === 'string' && candidate !== '' && existsSync(candidate)) ?? 'node.exe';
}

export function command(exe, args, env) {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(exe)) return { exe, args };
  const shim = readFileSync(exe, 'utf8');
  const redirected = shim.match(/^call "%APPDATA%\\npm\\([a-z0-9-]+\.cmd)" %\*$/im);
  if (redirected && env.APPDATA && resolve(exe) !== resolve(env.APPDATA, 'npm', redirected[1])) {
    return command(resolve(env.APPDATA, 'npm', redirected[1]), args, env);
  }
  const npm = shim.match(/"%_prog%"\s+"%dp0%[\\/]?([^"\r\n]+)"\s+%\*/i);
  const simple = shim.match(/^\s*"?node(?:\.exe)?"?\s+"%~dp0([^"\r\n]+)"\s+%\*/im);
  if (npm || simple) {
    const runtime = /SET "_prog=bun"/i.test(shim) ? 'bun' : 'node';
    const local = join(dirname(exe), runtime + '.exe');
    const npmBun = env.APPDATA && join(env.APPDATA, 'npm', 'node_modules', 'bun', 'bin', 'bun.exe');
    return {
      exe: existsSync(local) ? local : runtime === 'node' ? nodeRuntime(env)
        : npmBun && existsSync(npmBun) ? npmBun : 'bun.exe',
      args: [join(dirname(exe), (npm || simple)[1]), ...args],
    };
  }
  // cmd expands metacharacters even inside quoted arguments. Keep unknown shims on a restricted path.
  if ([exe, ...args].some(arg => /[%!"^&|<>()\r\n\0]/.test(arg))) {
    throw problem('E_SHIM_ARGUMENT', 'This Windows shim cannot safely receive these arguments.', 'Select the native executable.');
  }
  return {
    exe: env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: ['/d', '/v:off', '/s', '/c', '"' + [exe, ...args].map(arg => '"' + arg.replace(/\\+$/, '$&$&') + '"').join(' ') + '"'],
    windowsVerbatimArguments: true,
  };
}

function windowsArgLength(arg) {
  if (!arg) return 2;
  if (!/[ \t"]/.test(arg)) return arg.length;
  let length = arg.length + 2;
  for (const match of arg.matchAll(/\\+|"/g)) {
    const end = match.index + match[0].length;
    if (match[0] === '"' || arg[end] === '"' || end === arg.length) length += match[0].length;
  }
  return length;
}

export async function run({ exe, args = [], stdin, cwd, env = process.env, timeoutMs = 30_000, signal, onLine, onSpawn, argvPrompt }) {
  const started = Date.now();
  if (signal?.aborted) return { cancelled: true, durationMs: 0, stdoutTail: '', stderrTail: '' };
  const spec = command(exe, args, env);
  const windows = process.platform === 'win32';
  if (windows && argvPrompt) {
    if (spec.windowsVerbatimArguments) {
      throw problem('E_SHIM_ARGUMENT', 'This adapter needs a native executable for its prompt.');
    }
    if ([spec.exe, ...spec.args].reduce((length, arg) => length + windowsArgLength(arg) + 1, 0) > 32_767) {
      throw problem('E_TASK', 'The prompt exceeds the Windows command-line limit.', 'Use a shorter prompt.');
    }
  }
  const child = spawn(spec.exe, spec.args, {
    cwd, env, shell: false, windowsHide: true, detached: !windows,
    windowsVerbatimArguments: spec.windowsVerbatimArguments, stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new Promise((resolveRun, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let pending = '';
    let timedOut = false;
    let cancelled = false;
    let termination;
    let killTimer;
    let finishing = false;
    let failure;
    const decoder = new StringDecoder('utf8');
    const tail = (previous, chunk) => Buffer.concat([previous, chunk]).subarray(-limit);

    function killGroup(name) {
      try {
        process.kill(-child.pid, name);
      } catch (error) {
        if (error.code !== 'ESRCH') failure ??= error;
      }
    }
    function stop() {
      if (!child.pid || termination) return;
      if (windows) {
        termination = new Promise(resolveKill => {
          let taskkill;
          const fallback = () => {
            if (child.exitCode === null && child.signalCode === null) child.kill();
            resolveKill();
          };
          // ponytail: taskkill is best effort without a Windows Job Object. Never wait indefinitely for inherited pipes.
          killTimer = setTimeout(() => {
            if (taskkill?.exitCode === null && taskkill.signalCode === null) taskkill.kill();
            fallback();
            child.stdin.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
            if (child.exitCode === null && child.signalCode === null) child.unref();
            void finish(child.exitCode, child.signalCode);
          }, 1000);
          try {
            taskkill = spawn(join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe'),
              ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            taskkill.once('error', fallback);
            taskkill.once('close', code => { if (code) fallback(); else resolveKill(); });
          } catch {
            fallback();
          }
        });
      } else {
        killGroup('SIGTERM');
        termination = new Promise(resolveKill => setTimeout(() => {
          killGroup('SIGKILL');
          resolveKill();
        }, 500));
      }
    }
    const abort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    function handleCallback(callback, value) {
      try {
        callback?.(value);
      } catch (error) {
        failure ??= error;
        stop();
      }
    }
    const deliver = line => handleCallback(onLine, line);
    child.once('spawn', () => handleCallback(onSpawn, child.pid));
    child.once('error', error => { if (!termination) failure ??= error; });
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      stdout = tail(stdout, chunk);
      const lines = (pending + decoder.write(chunk)).split(/\r?\n/);
      pending = lines.pop().slice(-limit);
      for (const line of lines) if (line) deliver(line.slice(-limit));
    });
    child.stderr.on('data', chunk => { stderr = tail(stderr, chunk); });
    async function finish(code, exitSignal) {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      pending += decoder.end();
      if (pending) deliver(pending);
      await termination;
      clearTimeout(killTimer);
      if (failure) return reject(failure);
      resolveRun({ code, signal: exitSignal, timedOut, cancelled, stdoutTail: stdout.toString('utf8'),
        stderrTail: stderr.toString('utf8'), durationMs: Date.now() - started });
    }
    child.once('close', finish);
    handleCallback(chunk => child.stdin.end(chunk), stdin);
  });
}
