// Builds dist/desktop/: the native panel window (Agents-MCP.Panel.exe, WinForms + WebView2)
// beside the service executable it starts. Requires the .NET SDK once; the published host
// is framework-dependent, so a machine only needs the WebView2 runtime Windows 10/11 ship.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const project = join(root, 'desktop');
const output = join(root, 'dist', 'desktop');
const service = join(root, 'dist', 'Agents-MCP.exe');

if (!existsSync(service)) throw new Error('Run npm run build:exe first; dist/Agents-MCP.exe is missing.');
const csproj = join(project, 'Agents-MCP.Panel.csproj');
const original = await readFile(csproj, 'utf8');
await writeFile(csproj, original.replace(/<Version>[\d.]+<\/Version>/, `<Version>${version}</Version>`));
try {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  // The restore step honours --configfile; publish then reads the restored assets.
  execFileSync('dotnet', ['publish', project, '-c', 'Release', '--self-contained', 'false',
    '--configfile', join(project, 'nuget.config'), '-o', output], { stdio: 'inherit' });
  await cp(service, join(output, 'Agents-MCP.exe'));
  // Keep only what the host loads: no symbol files, no XML docs, no WPF assembly.
  for (const name of await readdir(output)) {
    if (/\.(pdb|xml)$/.test(name) || name.includes('.Wpf.')) await unlink(join(output, name));
  }
  execFileSync(join(output, 'Agents-MCP.Panel.exe'), ['--check'], { stdio: 'inherit' });
  process.stdout.write('Built ' + output + ' (Agents-MCP.Panel.exe ' + version + ' + Agents-MCP.exe)\n');
} finally {
  await writeFile(csproj, original);
}
