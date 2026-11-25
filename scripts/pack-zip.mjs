// Packs the built executable into a portable zip for people who do not want a terminal or a
// Node.js install: unzip, double-click. Run `npm run build:exe` first.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const exe = join(root, 'dist', 'Agents-MCP.exe');
if (!existsSync(exe)) throw new Error('Run npm run build:exe first; dist/Agents-MCP.exe is missing.');
const stage = join(root, '.tmp', 'zip');
const archive = join(root, 'dist', 'Agents-MCP-' + version + '-win-x64.zip');

const guide = `Agents-MCP ${version}

1. 双击 Agents-MCP.exe
   服务在本机启动，面板会在默认浏览器打开 http://127.0.0.1:4870/
   没有控制台窗口是正常的：这个程序不带控制台。

2. 第一次使用
   在「Agents」页能看到本机装了哪些 Agent，并选择每个 Agent 的模型与思考强度。
   「设置」页可以让 exe 在桌面/开始菜单创建快捷方式，也可以开机自启。

3. 停止服务
   面板「设置」页 →「关闭服务」，或运行 Agents-MCP.exe --stop。

4. 出问题时
   日志在 %APPDATA%\\Agents-MCP\\launcher.log

参数：--port N 换端口，--state-dir DIR 换状态目录，--no-open 只启动不打开浏览器，
      --install [--startup] 创建快捷方式（可开机自启），--uninstall 删除快捷方式，
      --stop 停止正在运行的服务，--check 只校验可执行文件。

卸载：删除 Agents-MCP.exe 与 %APPDATA%\\Agents-MCP 即可，不写注册表。
`;

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await copyFile(exe, join(stage, 'Agents-MCP.exe'));
await copyFile(join(root, 'LICENSE'), join(stage, 'LICENSE'));
await writeFile(join(stage, '使用说明.txt'), guide, 'utf8');
await rm(archive, { force: true });
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "Compress-Archive -Path '" + join(stage, '*') + "' -DestinationPath '" + archive + "' -CompressionLevel Optimal"],
{ stdio: 'inherit' });
process.stdout.write('Packed ' + archive + '\n');
