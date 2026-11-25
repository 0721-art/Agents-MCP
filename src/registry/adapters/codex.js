// Verified 2026-11-25, 0.171.0-alpha.13.2: exec -C CWD -m M -s S -c K=V --json
// [--output-schema FILE] -o FILE -; exec resume -m M -c K=V --json -o FILE SID -.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { adapter, failure, home, json, localApp, locate, model, probeCommand, read, win } from './_common.js';

export default adapter({
  id: 'codex', name: 'Codex', supportsSchema: true,
  async locate(context) {
    const { env } = context;
    const root = join(env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files', 'WindowsApps');
    const paths = [];
    if (win && !context.overrides.exe && !env.AGENTS_MCP_CODEX_EXE) {
      try {
        const names = readdirSync(root).filter(name => /^OpenAI\.Codex_[\d.]+_/i.test(name));
        names.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
        paths.push(...names.map(name => join(root, name, 'app', 'resources', 'codex.exe')));
      } catch {
        const ps = await probeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          '(Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation'],
        env, context.signal).catch(() => null);
        if (ps?.stdoutTail.trim()) paths.push(join(ps.stdoutTail.trim(), 'app', 'resources', 'codex.exe'));
      }
      paths.push(join(localApp(env), 'Microsoft', 'WindowsApps', 'codex.exe'));
    }
    return locate('codex', context, [env.AGENTS_MCP_CODEX_EXE, ...paths]);
  },
  async probe({ exe, env, signal }) {
    const root = env.CODEX_HOME || join(home(env), '.codex');
    const config = read(join(root, 'config.toml'), '').split(/^\s*\[/m)[0];
    const effort = config.match(/^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m)?.[1];
    const current = config.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1];
    const models = (json(join(root, 'models_cache.json')).models || []).map(entry =>
      model(entry.slug, (entry.supported_reasoning_levels || []).map(level => level.effort).filter(Boolean),
        (entry.slug === current && effort) || entry.default_reasoning_level, entry.display_name))
      .filter(entry => entry.id && entry.efforts.length);
    if (!models.length) return failure('Codex model cache is empty.', 'Run Codex normally to populate models_cache.json.');
    const version = await probeCommand(exe, ['--version'], env, signal);
    return version.code === 0 ? { ok: true, models, version: version.stdoutTail.trim() }
      : failure('Codex could not start.', 'Select a working codex executable.', models);
  },
  buildArgs({ model: name, effort, cwd, permission, prompt, schemaPath, outputPath, sessionId }) {
    const sandbox = permission === 'write' ? 'workspace-write' : 'read-only';
    const args = sessionId ? ['exec', 'resume', '-c', 'sandbox_mode="' + sandbox + '"']
      : ['exec', '-C', cwd, '-s', sandbox, '--skip-git-repo-check'];
    args.push('-m', name, '-c', 'model_reasoning_effort="' + effort + '"',
      '-c', 'approval_policy="never"', '--json');
    if (schemaPath) args.push('--output-schema', schemaPath);
    if (outputPath) args.push('-o', outputPath);
    if (sessionId) args.push(sessionId);
    return { args: [...args, '-'], stdin: prompt, outputPath };
  },
  resumeArgs(options) { return this.buildArgs(options); },
});
