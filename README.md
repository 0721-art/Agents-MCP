# Agents-MCP

Agents-MCP 是一个本地 MCP 服务，带有网页控制台。它读取已安装 Agent CLI 的模型配置，按任务调度子进程，并保存运行记录和报告。运行时只使用 Node 标准库。

## 三种使用方式

| 方式 | 适合 | 怎么做 |
| --- | --- | --- |
| **下载即用** | 只想用，不装 Node、不看代码 | 从 [releases](https://github.com/0721-art/Agents-MCP/releases/latest) 下载 `Agents-MCP-win-x64.zip`，解压后双击 `Agents-MCP.exe`。双击 `Agents-MCP.Panel.exe` 打开普通应用窗口，**没有控制台窗口** |
| **自己构建** | 想改代码 | `npm i` → `npm run build:exe` → 双击 `dist/Agents-MCP.exe`；或 `npm run pack:zip` 生成可分发的压缩包 |
| **命令行 / MCP 主机** | 接入 Codex、Claude Code、DSH | `npm run connect:codex` / `connect:claude` / `connect:dsh`，或手动 `node bin/agents-mcp.js --mcp=stdio` |

exe 是单文件自包含程序：内嵌 Node 运行时与面板资源，可以放任意目录，不需要仓库，不写注册表。桌面/开始菜单快捷方式和开机自启都能在面板「设置」页一键创建（等价于 `Agents-MCP.exe --install [--startup]`）。停止服务用面板「设置」页的「关闭服务」或 `Agents-MCP.exe --stop`。

## 系统要求

- **Windows 10/11**：文件夹选择器走 PowerShell + WinForms，单文件 exe 走 Node SEA，均为 Windows 实现；macOS / Linux 未测试。
- **Node.js 22 或更新版本**：运行只需要标准库；只有构建 exe 时额外安装 esbuild（开发依赖）。
- **Agent CLI 按需准备**：Codex、Antigravity（`agy`）、DeepSeek Harness（`dsh`）、Pi、OMP 各自安装并登录；缺哪个就在面板里显示不可用，不影响其他 Agent。Grok 与 Claude 的适配器未做真实鉴权校验。
- **首次从源码使用**：`npm i`（只为构建 exe 安装 esbuild），然后 `npm test` 自检、`npm run build:exe` 生成可双击的程序。`dist/` 不进仓库。
## 启动

```powershell
node bin/agents-mcp.js                               # stdio MCP
node bin/agents-mcp.js --panel                       # stdio MCP 与本地面板
node bin/agents-mcp.js --mcp=http                     # HTTP MCP 与本地面板
node bin/agents-mcp.js --selftest                     # CLI 与模型目录探测
```

面板默认地址为 `http://127.0.0.1:4870/`，HTTP MCP 使用同一端口的 `/mcp`。MCP 服务名为 `agents`。stdio 主机使用 `node` 作为命令，并将 `bin/agents-mcp.js` 的绝对路径作为参数。

启动参数 `--port N` 可覆盖端口，`--state-dir DIR` 可覆盖状态目录。若默认目录不可写（例如低权限或受限账户），服务会自动回退到 `%LOCALAPPDATA%\Agents-MCP`，并在设置页注明回退到了哪里；`--state-dir` 指定的目录不可写时直接报错并给出可用的命令，不会静默丢数据。也可使用 `AGENTS_MCP_HOME`；默认目录在 Windows 是 `%APPDATA%\Agents-MCP`，在其他系统是 `$XDG_STATE_HOME/agents-mcp`，后者回退到 `~/.local/state/agents-mcp`。面板设置里的端口在重启后生效。

## 控制台

- **总开关**：标题栏右上角是「Agents-MCP 已启用 / 已停用」。停用后无论哪台客户端都会收到 `E_DISABLED`，不会启动任何 agent；工具仍然列得出来，只是调用必被拒绝，所以不会把客户端弄坏。这个开关是服务端的同一份状态，改完下一次调用就生效，不需要重启客户端。
- **Agent 端提示**：连接时（MCP `initialize`）服务会附带一段说明——当前是启用还是停用、两种模式各自开关、以及"第一次调用 `agents_*` 之前先用 `agents_gate` 问用户一次"；`agents_gate` 通过后返回 `notice`「Agents-MCP 已启用」，`agents_list` / `agents_flow_run` / `agents_delegate` 的结果里也带同一句，agent 会把它复述给用户。
- **Agents** 显示探测结果、模型和思考强度。可保存可执行文件路径和每个 Agent 的 HTTP/HTTPS 代理，之后重新检测。
- **模式 A** 选定参与者，填写或生成职责，再定义步骤、依赖和评审循环。成功的步骤可以把产物交给下游。工作目录可以直接输入，也可以点「浏览…」在系统文件夹对话框里选择。
  - 「帮我写职责」默认由参与者自己的 Agent 和模型代笔；参与者一栏上方的「职责代笔」可以指定另一个 Agent、模型和思考强度（例如让便宜的模型写初稿、让强的模型统一口径），选「跟随参与者自己的 Agent」即回到默认行为。代笔走的是同一条 `agents_draft_role` 通道，沙箱内只读、不写文件。
- **模式 B** 指定主 Agent、填写其他 Agent 的专长、设置委派上限。运行记录显示委派树。
- **运行记录** 展示步骤状态、耗时、思考过程、事件、产物和报告，运行期间可取消。
- **设置** 管理任务授权策略、两种模式的开关、端口、默认超时、并发和更新检查代理，并显示当前状态目录与版本。
- **接入状态**（设置页）现场回答"它现在到底有没有生效"：Codex CLI / Claude Code / DSH 各自是未接入、已注册还是使用中，最近一次调用是什么时候、共调用了几次；每一行右侧有一个开关，**停用 / 启用** 直接改那个客户端自己的配置。只读配置不够，它同时记录真实连接与工具调用。
- **环境自检**（设置页底部）现场检测：状态目录能不能写、桌面和开始菜单目录能不能写、更新通道是直连还是代理、代理端口连不连得上、运行版本。每一项都是即时探测，不是"应该是好的"。
- 待确认的任务授权超过 24 小时会自动失效（过期的提示不再挡住页面，下次运行重新询问）；也能在提示条上点「忽略」直接丢弃，忽略不等于拒绝，任务下次仍会询问。

## 思考过程

运行记录里的「思考过程」按步骤展开每个 Agent 的推理内容。能显示到什么程度取决于 CLI 本身：

| Agent | 面板显示的内容 |
| --- | --- |
| Claude Code | 流里的 `thinking` 内容块（若后端返回）。 |
| Codex | 有 reasoning 摘要时显示正文，否则只显示 `reasoning_output_tokens`。 |
| Antigravity | CLI 只上报 `thinking_tokens`，因此只显示思考 token 数。 |
| DSH / OMP / Pi / Grok | 按各家流事件的 reasoning 字段显示，缺失时只留 token 数。 |

思考正文同时写入该步骤的 `steps/<步骤>.md`（位于 `# Thinking` 段），最多保留 64 KiB；面板与报告只读取服务自己的运行目录，不读取 Agent 的私有会话存储。


首次运行一个任务时，服务默认请求人类授权。网页横幅和 MCP 工具使用同一个持久化决定。

## Agent 目录来源

| Agent | 模型与强度来源 |
| --- | --- |
| Codex | `models_cache.json`、`config.toml`。Windows 自动查找 AppX；可用面板或 `AGENTS_MCP_CODEX_EXE` 覆盖路径。 |
| Antigravity | `agy models`。带强度后缀的模型使用完整 ID，其他模型使用 CLI 默认强度。 |
| Claude Code | 本地设置、`ANTHROPIC_MODEL` 和 CLI 帮助公布的别名及强度选项。 |
| Pi | 本地 `models.json`、`models-store.json` 和思考强度设置。 |
| OMP | 本地 `models.yml` 和 `config.yml`。需要能正常启动的 OMP。 |
| Grok | `grok models` 和本地 `reasoning_effort`。需要已登录的 CLI。 |
| DeepSeek Harness | 官方 `dsh` CLI（`npm i -g @deepseek-ai/dsh`）。模型目录直接读你 DSH profile 里 `llm-pi-ai` 配置的供应商（例如 `new/cn:deepseek-v4.1-flash`），强度取该模型的 `reasoningEfforts`；headless 没有 `--model`/`--effort`，每次运行用临时 `--patch` 覆盖 `agent-default-model`，不改动用户 profile；headless 不读 DSH 的托管凭据库，凭据先取环境变量，再取 `~/.dsh/.credentials.yaml` 里同名 ref。 |

Agent 启动或探测失败时，面板显示原因和处置提示。Agent 的登录、凭据和配置由各 CLI 自行管理。

## 预设（模式 A）

模式 A 的参与者、步骤和评审循环由使用者自己填。填好之后可以在「流程编排」页点「保存当前为预设」，下次用下拉框「载入」即可复原；同名保存会覆盖。

预设属于本机个人数据，保存在状态目录的 `presets.json`（默认 `%APPDATA%\Agents-MCP\presets.json`），仓库里不带任何预设内容。文件是普通 JSON 数组，每项形如：

```json
[{ "id": "my-flow", "name": "我的流程", "description": "可选说明",
   "flow": { "task": "任务文本", "participants": [], "steps": [], "loops": [] } }]
```

`flow` 与 `POST /api/flow/run` 的请求体同构（`participants` 需含 `id/agent/model/effort`，`steps` 需含 `id/participant/task`，`loops` 用 `from/to/until/maxRounds`）。最多 50 条；缺字段的条目在读取时会被跳过，不会影响其他预设。

## 双击启动（单文件 exe）

```powershell
npm run build:exe          # 输出 dist/Agents-MCP.exe（服务本体）
npm run build:desktop     # 输出 dist/desktop/：Agents-MCP.Panel.exe + Agents-MCP.exe
```

双击 **`Agents-MCP.Panel.exe`** 会打开一个普通应用窗口（自己的图标和标题栏，不是浏览器），窗口里就是面板 `http://127.0.0.1:4870/`，配置、授权和运行记录都在这里调整。这个窗口程序会自动启动同目录的 `Agents-MCP.exe` 服务，**关掉窗口就停止服务**。两个 exe 都内嵌运行时，整个 `desktop` 文件夹可以复制到任意位置单独使用，不需要 Node.js、.NET 或仓库文件。

窗口用系统自带的 WebView2（Win10/11 都有）渲染；极少数精简系统缺它时，窗口会提示，到微软官网装「WebView2 常青版运行时」即可。

- 窗口程序（WinForms + WebView2）没有控制台窗口；菜单栏有「重新载入 / 开发者工具 / 在浏览器中打开」和「停止服务并退出」。`Agents-MCP.Panel.exe --browser` 则退回用默认浏览器打开。
- 只有服务 exe（没有窗口程序）时，双击 `Agents-MCP.exe` 仍可用：它用 Edge/Chrome 的 `--app` 模式开一个独立窗口；关掉那个窗口不停止服务，停止用「设置」页的「关闭服务」或 `--stop`。
- 停止服务：面板「设置」页 →「关闭服务」，或 `Agents-MCP.exe --stop`。
- 快捷方式：面板「设置」页 →「创建快捷方式」（可勾选开机自启），等价于 `Agents-MCP.exe --install [--startup]`，有窗口程序时快捷方式指向它；删除用「删除快捷方式」或 `--uninstall`。
- 再次双击不会重复启动：检测到本服务已在运行，只打开已有页面。
- 端口被其他程序占用时，依次向后尝试 10 个端口，全部失败才报错。
- 启动失败的原因同时写入 `%APPDATA%\Agents-MCP\launcher.log`（没有控制台，这是唯一能看到错误的地方）。
- 可选参数：`--port N`、`--state-dir DIR`、`--no-open`（只启动服务、不开窗口）、`--check`（只校验可执行文件）。
- 服务本体和源码版能力一致：`Agents-MCP.exe --mcp=stdio` 可以直接作为 MCP 主机里的命令，`Agents-MCP.exe --selftest` 打印同样的探测结果，`--mcp=http --panel` 同时开 HTTP MCP 与面板。
- 自己构建窗口程序需要一次 .NET SDK（`npm run build:desktop`）；使用者不需要，发布的 zip 里已经带着编译好的文件。
- exe 未做代码签名，首次运行可能出现 SmartScreen 提示，选择"仍要运行"即可。
- 打包版不含测试 fixture，`AGENTS_MCP_FIXTURES` 只对源码运行有效；Agent 仍按本机 CLI 的实际登录状态探测。
- exe 运行时通过 npm 安装的 Agent（如 `dsh`、`pi`）会改用 PATH 上的 `node` 执行其 shim；缺少 Node.js 时这些 Agent 会显示不可用并提示安装。

### 怎么确认它真的生效了

1. 打开面板 → 设置 → **接入状态**：三行分别是 Codex CLI、Claude Code、DSH。显示「已注册」表示配置写对了，显示「使用中」表示这个客户端刚刚真的连上并调用了工具。
2. 在客户端里让它调用任意 `agents_*` 工具（例如"列出可用 Agent"），回到面板刷新，那一行会立刻变成「使用中」并显示调用次数。
3. 「最近调用」按时间倒序列出最近 15 次工具调用：时间、客户端、工具名、耗时、任务开头。**这里没有任何记录，就说明任务没有经过本 MCP**——不是它没生效，而是那个 agent 根本没调用工具。
4. 想临时关掉，就在同一行点「停用」——Codex 会写入 `enabled = false`，Claude Code 会把这一条从 `~/.claude.json` 里摘下来（配置留在状态目录，点「启用」原样还回去），DSH 会给插件行加上 `disabled: true`。改完需要重启对应客户端。
5. 命令行同样可以看：`Agents-MCP.exe --bridges`（源码环境 `node bin/agents-mcp.js --bridges`）。

「已注册但从未调用」通常意味着客户端还没重启，或者它自己的 MCP 开关是关的（Codex 可以 `codex mcp list`、Claude Code 可以 `claude mcp list` 核对）。

## 排错

先看设置页的「环境自检」，或在命令行跑 `node bin/agents-mcp.js --selftest`（打包版 `Agents-MCP.exe --selftest`），它会打印每个 Agent 的状态、更新通道、状态目录与快捷方式目录的可写性。常见情况：

- **状态目录不可写**：低完整性进程或沙箱里 `%APPDATA%\Agents-MCP` 写不进去。程序会自动退到 `%LOCALAPPDATA%\Agents-MCP`，页面会写明退到了哪里；想固定就加 `--state-dir`。
- **快捷方式创建失败**：桌面或开始菜单目录不可写时会指出是哪个目录、为什么，可以手动右键 exe → 发送到 → 桌面快捷方式。
- **更新检查超时**：这台机器可能必须走代理。设置页填代理的 `host:port`（例如 `127.0.0.1:7892`），自检里会显示代理端口是否连得上。
- **某个 Agent 不可用**：自检与 Agent 列表都会给出原因和补救办法（比如 `grok login`、把 DSH 的 API key 存到 Models 页）。

## 更新

面板加载时会查一次 GitHub 上的最新 release，结果缓存在状态目录 6 小时（设置页的"检查更新"按钮会强制刷新）。发现新版本时顶部出现提示条，按运行方式给出不同动作：

- **git checkout 运行**：按钮是"更新到 vX"，执行 `git pull --ff-only` + `npm install`，完成后重启服务生效。
- **打包 exe 运行**：按钮是"立即更新到 vX"，从 release 里按名字取回两个 exe（服务 `Agents-MCP.exe` 与窗口 `Agents-MCP.Panel.exe`），都下载并校验大小与 `sha256` 之后才动手替换，全部替换成功再由窗口程序自己重启到新版本。
- 替换是"先备份再换"：旧文件留成 `.old`，任何一步失败都会回滚，原版本照常可用。文件夹不可写时先存成 `.new`，下次启动自动换上。校验不通过则丢弃下载的文件，一个字节都不会换。
- 两步操作都在面板里完成，不需要手动下载；只有设置目录完全不可写、无法暂存新版本时，才提示去打开发布页。
- 点"稍后"只是本次页面隐藏提示，重新加载会再提醒。
- **必须走代理的机器**：设置页有「更新检查代理」，填 `127.0.0.1:7892` 这样的 host:port 即可；留空时读取 `AGENTS_MCP_PROXY` 或 `HTTPS_PROXY`。代理不通会在面板直接说明（握手被拒、连不上、超时分别提示），不会静默失败。
- 不想联网检查：`AGENTS_MCP_NO_UPDATE_CHECK=1`。设置页始终显示当前版本。

## 接入其它 Agent（MCP）

让 Codex、Claude Code、DSH 直接调用这套工具，不用切窗口：

```bash
npm run connect:codex                      # 写进 ~/.codex/config.toml
npm run connect:claude                     # 写进 Claude Code 的 user 配置
npm run connect:dsh                        # 生成 bridge bundle 并装进 DSH profile

npm run connect:codex  -- --list           # 看当前注册了什么（三个都支持）
npm run connect:claude -- --remove         # 撤销（三个都支持）
```

三者启动的都是同一个 `node bin/agents-mcp.js --mcp=stdio`，共用 `%APPDATA%\Agents-MCP` 状态目录 —— 面板里跑过的流程、门禁记录、运行记录，在这三个 Agent 里都读得到，反过来也一样。

**Codex**（`[mcp_servers.agents-mcp]`）：默认每次 MCP 调用都会要求批准。想让它免批准：

```bash
npm run connect:codex -- --approve
```

这会在 `[mcp_servers.agents-mcp]` 里加 `default_tools_approval_mode = "approve"`（只动这一行）。**注意**：批准意味着 Codex 可以不经询问就派活给别的 Agent、跑会写文件的流程，按需开启。

**Claude Code**（默认 `-s user`，即全局）：`npm run connect:claude -- --scope project` 可以改成项目级。注册完 `claude mcp list` 会做健康检查，正常显示 `agents-mcp … √ Connected`；工具名是 `mcp__agents-mcp__<Tool>`。

**DSH**：

- bundle 生成在 `%APPDATA%\Agents-MCP\dsh-bundle`（带绝对路径，所以不放进仓库）。
- `desktop` profile 归 DSH 窗口所有，启动器拒绝命令行安装：脚本会打印 bundle 路径，从 DSH 的插件页选择“从文件夹安装”即可（DSH 自己也能装）。
- 装好后 DSH 会话里多出 `mcp__agents-mcp__agents_list`、`agents_flow_run`、`agents_status` 等工具。
- 桥接进程只开 stdio，不抢占面板端口。

三个都支持 `-- --exe PATH` 指定找不到的 CLI；脚本会复用适配器的定位逻辑（例如 Codex 的 appx 安装目录）。

## 验证

```powershell
npm test
node bin/agents-mcp.js --selftest
node scripts/mcp-smoke.mjs
```

`AGENTS_MCP_FIXTURES=1` 启用离线 fixture，便于在没有登录真实 Agent 的环境中验证面板。可选 Antigravity 实测需要显式设置 `AGENTS_MCP_LIVE=1`，再运行 `node --test scripts/live-agy.mjs`。

适配器契约、MCP 输入形状和状态布局见 [架构说明](docs/ARCHITECTURE.md)。

## 许可

MIT
