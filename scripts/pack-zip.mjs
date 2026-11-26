// Packs the built executable into a portable zip for people who do not want a terminal or a
// Node.js install: unzip, double-click. Run `npm run build:exe` first.
import { execFileSync } from 'node:child_process';
import { cp, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const desktop = join(root, 'dist', 'desktop');
if (!existsSync(join(desktop, 'Agents-MCP.Panel.exe'))) throw new Error('Run npm run build:desktop first; dist/desktop/Agents-MCP.Panel.exe is missing.');
const stage = join(root, '.tmp', 'zip');
const archive = join(root, 'dist', 'Agents-MCP-' + version + '-win-x64.zip');

const guide = `Agents-MCP ${version}

1. 双击 Agents-MCP.Panel.exe
   这是一个普通应用窗口（自己的图标和标题，不是浏览器标签）。它会自动启动本机服务并在窗口里显示面板。
   如果提示缺少 WebView2 运行时（Win10/11 一般自带），到 https://developer.microsoft.com/microsoft-edge/webview2/ 下载「常青版」安装即可。

2. 第一次使用
   在「Agents」页能看到本机装了哪些 Agent，并选择每个 Agent 的模型与思考强度。
   「设置」页可以创建桌面/开始菜单快捷方式，也可以开机自启。

3. 关闭
   关掉窗口即停止服务；面板「设置」页也有「关闭服务」。

4. 出问题时
   日志在 %APPDATA%\\Agents-MCP\\launcher.log

参数：--port N 换端口，--state-dir DIR 换状态目录，--browser 用默认浏览器打开而不开桌面窗口。
      同目录的 Agents-MCP.exe 是服务本体：--mcp=stdio 作为 MCP 服务器，--selftest 探测 Agent，--stop 停止服务。

卸载：删除这个文件夹与 %APPDATA%\\Agents-MCP 即可，不写注册表。
`;

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(desktop, stage, { recursive: true });
await copyFile(join(root, 'LICENSE'), join(stage, 'LICENSE'));
await writeFile(join(stage, '使用说明.txt'), guide, 'utf8');
await rm(archive, { force: true });
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "Compress-Archive -Path '" + join(stage, '*') + "' -DestinationPath '" + archive + "' -CompressionLevel Optimal"],
{ stdio: 'inherit' });
process.stdout.write('Packed ' + archive + '\n');
