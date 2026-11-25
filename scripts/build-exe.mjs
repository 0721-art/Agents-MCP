// Builds dist/Agents-MCP.exe: one self-contained file that starts the local panel and opens it.
// The bundle embeds panel/index.html, panel.js and panel.css, so the executable runs without the
// repository and without a separate Node.js install.
import { execFileSync } from 'node:child_process';
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

await build({
  entryPoints: [join(root, 'src', 'app.js')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'warning',
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

execFileSync(process.execPath, ['--build-sea=' + config], { cwd: root, stdio: 'inherit' });
const check = execFileSync(output, ['--check'], { encoding: 'utf8' });
process.stdout.write(check);
process.stdout.write('Built ' + output + '\n');
