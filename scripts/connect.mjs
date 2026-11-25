// Mounts this checkout as an MCP server inside another agent, so that agent can call
// the agents_* tools directly (list the fleet, gate a task, run a flow, dispatch).
//
//   npm run connect:codex                 # Codex CLI (~/.codex/config.toml)
//   npm run connect:claude                # Claude Code (user scope)
//   npm run connect:dsh                   # DeepSeek Harness profile
//   npm run connect:codex -- --remove     # undo, same for the others
//   npm run connect:codex -- --list       # show what the agent already has
//
// Every target launches `node bin/agents-mcp.js --mcp=stdio`. The node has to be a real
// one: inside the packaged exe `process.execPath` is the exe itself, so nodeRuntime()
// resolves an interpreter from PATH instead (the same rule the runner uses for npm shims).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import codexAdapter from '../src/registry/adapters/codex.js';
import claudeAdapter from '../src/registry/adapters/claude.js';
import { stateDirectory } from '../src/engine/store.js';
import { nodeRuntime } from '../src/runner/exec.js';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const serverName = 'agents-mcp';
const serverEntry = join(repo, 'bin', 'agents-mcp.js');
const node = nodeRuntime();
const launchCommand = [node, serverEntry, '--mcp=stdio'];

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: 'string', default: 'desktop' },
    scope: { type: 'string', default: 'user' },
    dir: { type: 'string' },
    exe: { type: 'string' },
    remove: { type: 'boolean' },
    list: { type: 'boolean' },
    approve: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});

const usage = [
  'Usage: connect <codex|claude|dsh> [options]',
  '',
  '  codex    register with the Codex CLI (~/.codex/config.toml)',
  '  claude   register with Claude Code (scope user by default)',
  '  dsh      generate a DSH bundle and install it into a profile',
  '',
  'Options:',
  '  --remove           undo a previous registration',
  '  --list             print what the target already has (no changes)',
  '  --approve          codex only: let its MCP calls run without asking for approval',
  '  --exe PATH         the agent CLI to drive, when it is not where we look',
  '  --scope NAME       Claude Code scope: user (default), project, local',
  '  --profile NAME     DSH profile: desktop (default), web, headless',
  '  --dir PATH         where the DSH bundle is generated',
  '  --help',
  '',
].join('\n');

if (values.help || positionals.length !== 1) {
  process.stdout.write(usage);
  process.exit(values.help ? 0 : 2);
}

if (!existsSync(serverEntry)) {
  process.stderr.write('Agents-MCP: ' + serverEntry + ' is missing. Run this from a full checkout.\n');
  process.exit(1);
}

const env = process.env;
const target = positionals[0];

function failure(message) {
  process.stderr.write('Agents-MCP: ' + message + '\n');
  process.exit(1);
}

// Runs one agent CLI and returns its combined output; a missing executable is a real
// error here, because registration must not silently do nothing.
function call(exe, args) {
  const result = spawnSync(exe, args, { encoding: 'utf8', env, cwd: repo });
  if (result.error) failure('could not run ' + exe + ': ' + result.error.message);
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? '') };
}

async function resolveCli(adapter, name) {
  if (values.exe) return resolve(values.exe);
  const found = await adapter.locate({ overrides: {}, env });
  if (found?.exe) return found.exe;
  const onPath = spawnSync(name, ['--version'], { encoding: 'utf8', env });
  if (!onPath.error) return name;
  return failure('could not find the ' + name + ' CLI. Install it, or pass --exe PATH.');
}

function report(name, status, output, success) {
  if (status !== 0) {
    process.stderr.write(output.trim() + '\n');
    failure(name + ' exited with code ' + status + '.');
  }
  if (success) process.stdout.write(success + '\n');
  const notable = output.trim().split(/\r?\n/).filter(line => line.includes(serverName)).slice(0, 12);
  if (notable.length) process.stdout.write(notable.join('\n') + '\n');
}

// Codex asks for approval before every MCP tool call. The opt-in flag below flips that
// for this one server by adding the supported config key next to its table; nothing else
// in the file is touched, and `codex mcp remove` still takes the table away.
function codexApprove() {
  const config = join(env.CODEX_HOME || join(env.USERPROFILE || '', '.codex'), 'config.toml');
  const table = '[mcp_servers.' + serverName + ']';
  const key = 'default_tools_approval_mode = "approve"';
  if (!existsSync(config)) return failure('Codex has no config.toml yet; run the registration first.');
  const lines = readFileSync(config, 'utf8').split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === table);
  if (start < 0) return failure('Codex has no ' + table + ' table yet; run the registration first.');
  let end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  if (end < 0) end = lines.length;
  if (lines.slice(start, end).some(line => line.includes('default_tools_approval_mode'))) {
    process.stdout.write('Codex already approves ' + serverName + ' tool calls.\n');
    return undefined;
  }
  lines.splice(start + 1, 0, key);
  writeFileSync(config, lines.join('\n'));
  process.stdout.write('Codex will now run ' + serverName + ' tool calls without asking. '
    + 'Undo with: codex mcp remove ' + serverName + '\n');
  return undefined;
}

async function connectCodex() {
  const exe = await resolveCli(codexAdapter, 'codex');
  if (values.list) {
    const { status, output } = call(exe, ['mcp', 'get', serverName]);
    process.stdout.write(status === 0 ? output : 'Codex has no ' + serverName + ' server yet.\n');
    return;
  }
  if (values.remove) {
    const { status, output } = call(exe, ['mcp', 'remove', serverName]);
    report('codex mcp remove', status, output, status === 0 ? 'Removed ' + serverName + ' from Codex.' : '');
    return;
  }
  const { status, output } = call(exe, ['mcp', 'add', serverName, '--', ...launchCommand]);
  report('codex mcp add', status, output,
    'Registered ' + serverName + ' with Codex (' + exe + ').\n'
    + 'Restart Codex sessions; the tools appear as ' + serverName + ' tools (agents_list, agents_gate, agents_flow_run, …).\n');
  if (values.approve) codexApprove();
}

async function connectClaude() {
  const exe = await resolveCli(claudeAdapter, 'claude');
  if (values.list) {
    const { status, output } = call(exe, ['mcp', 'get', serverName]);
    process.stdout.write(status === 0 ? output : 'Claude Code has no ' + serverName + ' server yet.\n');
    return;
  }
  if (values.remove) {
    const { status, output } = call(exe, ['mcp', 'remove', serverName, '-s', values.scope]);
    report('claude mcp remove', status, output, status === 0 ? 'Removed ' + serverName + ' from Claude Code.' : '');
    return;
  }
  const { status, output } = call(exe, ['mcp', 'add', '-s', values.scope, serverName, '--', ...launchCommand]);
  report('claude mcp add', status, output,
    'Registered ' + serverName + ' with Claude Code, scope ' + values.scope + ' (' + exe + ').\n'
    + 'Restart Claude Code sessions; the tools appear as mcp__' + serverName + '__<Tool>.\n');
}

function dshCli() {
  const npm = env.APPDATA && join(env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (npm && existsSync(npm)) return npm;
  return failure('could not find the DSH launcher. Install it with: npm i -g @deepseek-ai/dsh');
}

const dshPackage = 'dsh-agents-mcp';

function dshBundle(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: dshPackage,
    version: '1.0.0',
    private: true,
    description: 'Mounts the local Agents-MCP server as an MCP bridge inside this DSH profile.',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n');
  const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '# Generated by `npm run connect:dsh` from the Agents-MCP checkout at:',
    '#   ' + repo,
    '# Every tool becomes mcp__' + serverName + '__<ToolName> in DSH sessions.',
    '- insert:',
    '    - id: agents-mcp-bridge',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: ' + serverName,
    '        transport: stdio',
    '        command: ' + quote(node),
    '        args:',
    '          - ' + quote(serverEntry),
    '          - "--mcp=stdio"',
    '        cwd: ' + quote(repo),
    '        # A flow step can run a whole agent turn; keep the call alive long enough.',
    '        toolCallTimeoutMs: 900000',
    '        # A broken bridge must never stop DSH from booting.',
    '        failOnStartupError: false',
    '        reconnect:',
    '          enabled: true',
    '          initialDelayMs: 500',
    '          maxDelayMs: 30000',
    '          maxAttempts: 10',
    '',
  ].join('\n'));
  return dir;
}

function connectDsh() {
  const cli = dshCli();
  const dir = values.dir ?? join(stateDirectory(undefined, env), 'dsh-bundle');
  if (values.list) {
    const { output } = call(node, [cli, 'plugin', '--profile', values.profile, 'list']);
    process.stdout.write(output);
    return;
  }
  if (!values.remove) dshBundle(dir);
  const { status, output } = call(node,
    [cli, 'plugin', '--profile', values.profile, values.remove ? 'remove' : 'add', dshPackage]);
  if (status === 0) {
    process.stdout.write(values.remove
      ? 'Removed ' + dshPackage + ' from the ' + values.profile + ' profile.\n'
      : 'Installed ' + dshPackage + ' into the ' + values.profile + ' profile from ' + dir + '.\n'
        + 'Restart DeepSeek Harness, then ask it to call agents_status.\n');
    return;
  }
  if (/managed exclusively by the Electron application/.test(output)) {
    process.stdout.write('The ' + values.profile + ' profile is owned by the DSH window, so the launcher '
      + 'refuses CLI installs.\n' + (values.remove
        ? 'Remove it from DSH: Plugins → ' + dshPackage + ' → uninstall.\n'
        : 'The bundle is ready at:\n  ' + dir + '\n'
          + 'Install it from DSH: Plugins → install from folder → that path (or tell DSH itself to install it).\n'));
    return;
  }
  report('dsh plugin', status, output, '');
}

if (target === 'codex') await connectCodex();
else if (target === 'claude') await connectClaude();
else if (target === 'dsh') connectDsh();
else {
  process.stderr.write('Agents-MCP: unknown target "' + target + '".\n\n' + usage);
  process.exit(2);
}
