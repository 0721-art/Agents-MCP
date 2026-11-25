// Builds dist/Agents-MCP.exe: one self-contained file that starts the local panel and opens it.
// The bundle embeds panel/index.html, panel.js and panel.css, so the executable runs without the
// repository and without a separate Node.js install.
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = join(root, '.tmp', 'exe');
const output = join(root, 'dist', 'Agents-MCP.exe');
const bundle = join(work, 'app.cjs');
const config = join(work, 'sea-config.json');

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
await mkdir(dirname(output), { recursive: true });
// Windows locks a running executable, so fail before spending the build on a target that cannot be written.
try {
  closeSync(openSync(output, 'r+'));
} catch (error) {
  if (['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) {
    throw new Error('Close the running Agents-MCP.exe first; Windows locks the file while it runs.');
  }
  if (error.code !== 'ENOENT') throw error;
}

// The exe has no package.json beside it, so the version it reports is baked in here.
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

await build({
  entryPoints: [join(root, 'src', 'app.js')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'warning',
  define: { 'process.env.AGENTS_MCP_VERSION': JSON.stringify(version) },
});

await writeFile(config, JSON.stringify({
  main: bundle,
  output,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: {
    'index.html': join(root, 'panel', 'index.html'),
    'panel.js': join(root, 'panel', 'panel.js'),
    'panel.css': join(root, 'panel', 'panel.css'),
  },
}, null, 2) + '\n');

try {
  execFileSync(process.execPath, ['--build-sea=' + config], { cwd: root, stdio: 'inherit' });
} catch (error) {
  if (/resource busy or locked/i.test(String(error?.stderr ?? '') + String(error?.message ?? ''))) {
    throw new Error('Close the running Agents-MCP.exe first; Windows locks the file while it runs.');
  }
  throw error;
}
const check = execFileSync(output, ['--check'], { encoding: 'utf8' });
process.stdout.write(check);

// Node builds a console executable, so double-clicking flashes a terminal window. Flip the PE
// subsystem to GUI (2) instead of console (3): the same process, no window. Progress and
// failures still land in %APPDATA%\Agents-MCP\launcher.log.
const image = readFileSync(output);
const pe = image.readUInt32LE(0x3c);
if (image.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('The built file is not a PE executable.');
const optional = pe + 24;
const magic = image.readUInt16LE(optional);
if (magic !== 0x10b && magic !== 0x20b) throw new Error('Unknown PE optional header magic ' + magic + '.');
const subsystemAt = optional + 0x44;
const subsystem = image.readUInt16LE(subsystemAt);
if (subsystem !== 2) {
  image.writeUInt16LE(2, subsystemAt);
  await writeFile(output, image);
}
process.stdout.write('Built ' + output + ' (subsystem ' + subsystem + ' -> ' + image.readUInt16LE(subsystemAt) + ')\n');
