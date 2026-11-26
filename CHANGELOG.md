# 更新记录

## 0.1.7

- **环境自检**：设置页底部与 `--selftest` 现在现场报告状态目录、桌面/开始菜单目录的可写性，以及更新通道（直连或代理、来源、端口可达性）。报告里的"失败没有原因"这一类问题，靠它自查。
- `--selftest` 在 Agent 列表之后追加 update / state / desktop / programs 四行事实。
- README 新增「排错」一节，对应官方问题总结里的权限与代理两类环境问题。

## 0.1.6

- **更新检查支持代理**：设置页新增「更新检查代理」（`host:port`），也可用 `AGENTS_MCP_PROXY` 或 `HTTPS_PROXY`。在一键更新必须经过本机代理的环境里，之前只会 5 秒超时，现在能真的查到新版本并下载。
- 代理不可用时给出具体原因（隧道被拒、拒绝连接、超时），面板不再把失败说成「已是最新版本」。
- 走代理下载发布包时跟随 302 跳转：GitHub 的资产下载会先跳到存储域名，之前会停在跳转状态直接报错。

## 0.1.5

- **一键更新**：打包版发现新版本后点「立即更新到 vX」，会在面板里下载 release 的 exe、校验 sha256、替换自身并重启；目标文件夹不可写时暂存为 `.new`，下次启动自动换上。
- **状态目录回退**：默认目录不可写（低权限、受限账户）时自动回退到 `%LOCALAPPDATA%\Agents-MCP`，设置页会说明回退位置；`--state-dir` 不可写则直接报错并给出可用命令，不再卡在「正在读取 Agent」。
- **启动不再阻塞**：Agent 目录先读本地缓存立即响应，探测在后台刷新（10 分钟内视为新鲜），首次打开不会因为 10 秒探测而空白。
- **授权请求会过期**：待确认的授权 24 小时后自动失效，并新增「忽略」按钮，过期的旧提示不会一直挂在顶部。
- **快捷方式失败说清原因**：`--install` 遇到权限问题会指出是哪个文件夹、并给出替代做法（手动创建快捷方式），不再只打印 PowerShell 异常。
- **exe 与源码能力对齐**：`Agents-MCP.exe --mcp=stdio|http`、`--panel`、`--selftest` 与 `node bin/agents-mcp.js` 用法一致；`node bin/agents-mcp.js --no-open` 也不再报未知参数。
- **Antigravity 探测错误分类**：区分超时、未登录、网络不可达与其他失败，并附上 CLI 的最后一行输出。

## 0.1.4

- **职责代笔可指定 Agent**：参与者一栏新增「职责代笔」，可以指定任意已安装的 Agent、模型与思考强度来生成职责，默认仍跟随参与者自己的 Agent。

## 0.1.3

- **命令行启动也能被停止**：以 `node bin/agents-mcp.js --panel` 或 `--mcp=http` 启动的进程现在同样支持面板「关闭服务」与 `Agents-MCP.exe --stop`（此前只有双击启动的进程能被停止）。

## 0.1.2

- **下载即用**：release 里直接提供 `Agents-MCP-win-x64.zip`（exe + 使用说明 + LICENSE），解压双击即可，不需要 Node.js。`npm run pack:zip` 可自行生成同一个包。
- **不再弹控制台窗口**：构建时把可执行文件的 PE 子系统从 console 改为 GUI，双击只有浏览器里的面板；错误仍写入 `%APPDATA%\Agents-MCP\launcher.log`。
- **快捷方式与开机自启**：面板「设置」页新增「创建快捷方式 / 删除快捷方式」，可勾选开机自启；命令行对应 `--install [--startup]` 与 `--uninstall`。
- **关闭服务**：面板「设置」页新增「关闭服务」，命令行对应 `--stop`（旧版只能关控制台或结束进程）。面板与 `--stop` 走 `POST /api/shutdown`，仅本机回环地址可用。
- **修掉一个端口坑**：单实例检测与 `--stop` 改用 `node:http`，不再受 fetch 规范的禁用端口（5060/5061 等）影响。

## 0.1.1

- **更新提醒**：面板加载时检查一次 GitHub release（结果缓存 6 小时，可在设置里点"检查更新"强制刷新）；发现新版本时顶部出现提示条。从 git checkout 运行的版本可以直接点"更新"拉取并装依赖，打包后的 exe 只提供发布页链接（运行中的 exe 无法替换自身）。设置页显示当前版本；`AGENTS_MCP_NO_UPDATE_CHECK=1` 可完全关掉检查。
- **Codex 接入**：`npm run connect:codex` 把本服务写进 `~/.codex/config.toml` 的 `[mcp_servers.agents-mcp]`，Codex 会话里直接出现 `agents_list`、`agents_flow_run` 等工具。`--approve` 可选地关掉每次调用的批准提示。
- **Claude Code 接入**：`npm run connect:claude` 以 user 作用域注册（`--scope project|local` 可改），注册后 `claude mcp list` 的健康检查显示已连接。
- **一个入口**：`scripts/connect.mjs <codex|claude|dsh>` 统一三家接入，都支持 `--list`、`--remove`、`--exe PATH`；三者共用同一个状态目录，面板与各 Agent 看到同一批运行记录。

## 0.1.0

首个可试用版本，面向 Windows 本地使用。

- **两种协作模式**：模式 A 由用户编排参与者、步骤与评审循环；模式 B 由主 Agent 通过 `@@AGENTS_MCP delegate/report` 协议自行派活并向用户汇报。两种模式独立开关，任务开始前只询问一次。
- **Agent 目录**：Codex、Antigravity、DeepSeek Harness、Pi、OMP、Claude、Grok 的适配器，模型与思考强度都从各家自己的配置/帮助里读取；DSH 直读 profile 里的 `llm-pi-ai` 供应商，并从环境变量或 `~/.dsh/.credentials.yaml` 取凭据。
- **MCP 服务**：stdio 与 HTTP 两种传输，工具包括 `agents_list`、`agents_gate`、`agents_flow_plan`、`agents_flow_run`、`agents_delegate`、`agents_status`、`agents_cancel`、`agents_draft_role`。
- **网页控制台**：Agents、模式 A、模式 B、运行记录、设置五个视图，含思考过程、步骤表、委派树、工作目录浏览、流程校验与预设保存。
- **运行记录**：每个运行保存提示词、产物、思考与报告到状态目录，步骤结果可追溯。
- **单文件 exe**：`npm run build:exe` 生成 `dist/Agents-MCP.exe`，双击启动服务并打开面板；重复启动只重新打开页面。
- **DSH 桥接**：`npm run connect:dsh` 生成并安装 MCP bridge，让 DSH 会话直接调用这些工具。

已知限制：仅在 Windows 验证；Claude 与 Grok 适配器未做真实鉴权校验；Grok 需要先 `grok login`；DSH 的 `desktop` profile 只能在 DSH 插件页安装 bridge。
