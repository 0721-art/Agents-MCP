# Agents-MCP v1 架构

`bin/agents-mcp.js` 创建服务实例，并按启动参数打开 stdio 或回环 HTTP。两种 MCP 传输和面板 JSON API 调用同一个服务，因此使用同一份授权、配置和运行记录。

| 模块 | 职责 |
| --- | --- |
| `src/server.js`、`src/config.js` | 组装服务，校验配置和工作目录，记录并管理后台运行。 |
| `src/app.js`、`src/launcher.js` | 双击入口：定位空闲端口、复用已运行实例、用默认浏览器打开面板；`--install/--uninstall/--stop` 分别创建快捷方式、删除快捷方式和关闭正在运行的服务。 |
| `desktop/Program.cs` | 原生面板窗口（WinForms + WebView2）：`Agents-MCP.Panel.exe` 启动同目录的 `Agents-MCP.exe --no-open`，轮询 `/api/config` 找到实际端口后把 WebView2 指过去；关窗时 POST `/api/shutdown` 再兜底结束子进程。菜单含重新载入 / 开发者工具 / 在浏览器中打开 / 停止并退出。 |
| `scripts/build-desktop.mjs` | `npm run build:desktop`：把 csproj 版本对齐 package.json，`dotnet publish`（框架依赖，需 .NET SDK 一次）到 `dist/desktop/`，复制服务 exe，去掉 pdb/xml/Wpf，最后跑 `--check`。 |
| `scripts/make-icon.mjs` | 不依赖图像库，直接写多尺寸 ICO（圆角底 + 三个彩色圆点）。 |
| `src/window.js` | 面板以桌面窗口打开：按 Edge → Chrome 的顺序在三个安装根目录里找浏览器，用 `--app=<url>`、独立 `--user-data-dir`（`<状态目录>/window-profile`）和固定窗口尺寸启动，脱离父进程运行；找不到浏览器时退回 `openUrl`。 |
| `src/shortcut.js` | 用 WScript.Shell 在桌面、开始菜单（可选启动项）写 `Agents-MCP.lnk`；路径由环境变量推导，便于测试；失败时指明是哪个文件夹不可写并给出替代做法。 |
| `scripts/pack-zip.mjs` | 把 exe、使用说明与 LICENSE 打成 `dist/Agents-MCP-<版本>-win-x64.zip`。 |
| `src/cli.js` | 源码入口与打包入口共用的启动逻辑：解析 `--panel/--mcp/--port/--state-dir/--selftest/--no-open`、打印自检表、按 stdio 或 HTTP 起服务。 |
| `src/update.js` | 查最新 release（缓存 6 小时）、git checkout 走 `git pull --ff-only`，打包版则下载同名 exe、校验大小与 `sha256`、替换自身并重启；替换失败时保留 `.new` 待下次启动。 |
| `src/bridges.js` | 判断每个客户端是否接入（读 Codex `config.toml`、`~/.claude.json`、DSH profile 的 bundle 列表）并记录真实使用（`initialize` 的 clientInfo 与工具调用次数写到 `bridges.json`；每次调用的工具、耗时、任务前 200 字追加到 `calls.ndjson`，512 KB 后轮转），`GET /api/bridges` 与 `--bridges` 共用。 |
| `src/diagnose.js` | `environmentReport()` 现场探测状态目录与快捷方式目录的可写性、更新通道来源与代理端口可达性；`GET /api/health` 与 `--selftest` 共用这一份结果。 |
| `src/proxy.js` | 更新检查与下载走 HTTP CONNECT 隧道（`http://` 代理只用于明文请求）：自己建立隧道并完成 TLS，因为 Node 的 fetch 不读系统代理设置。代理地址来自配置、`AGENTS_MCP_PROXY` 或 `HTTPS_PROXY`。 |
| `src/assets.js` | 读取面板静态文件：开发目录直接读盘，单文件 exe 从内嵌资源读取。 |
| `src/mcp/` | JSON-RPC 2.0、工具声明、逐行 stdio 与 Streamable HTTP。 |
| `src/panel/server.js`、`src/panel/folder.js`、`panel/` | 回环监听、静态页面、同源 JSON API，以及用系统文件夹对话框选择工作目录。 |
| `src/presets.js` | 读写状态目录里的 `presets.json`：校验、去重、同名覆盖，面板据此载入和保存模式 A 预设。 |
| `src/registry/` | 定位 CLI、并行探测目录、缓存结果并返回可操作的健康提示。10 分钟内的缓存直接返回，过期缓存先应答再后台刷新，所以面板首屏不再等一次全量探测。 |
| `src/runner/` | 安全启动进程、解析行事件、限制输出缓冲，处理超时和取消。 |
| `src/engine/` | 持久化授权、依赖图与评审循环、委派循环、原子状态写入。 |

## 适配器契约

每个 `src/registry/adapters/*.js` 导出一个对象，包含 `id`、`name`、`kind` 以及下列方法。

| 方法 | 输入与输出 |
| --- | --- |
| `locate` | 接收 `{overrides, env, signal}`，返回 `{exe, source, version?}` 或 `null`。 |
| `probe` | 接收 `{exe, env, signal}`，返回 `{ok, models, warnings?, reason?, remedy?, version?}`。模型包含 `id`、`label`、`efforts` 和 `defaultEffort`。 |
| `buildArgs` | 接收 `{model, effort, cwd, permission, prompt, schemaPath?, promptPath?, sessionId?}`，返回 `{args, stdin?}`。 |
| `parseStream` | 将一行输出映射为 `assistant`、`reasoning`、`tool`、`result`、`error` 或 `raw` 事件。 |
| `env` | 提供额外进程环境。用户代理覆盖只允许 HTTP_PROXY、HTTPS_PROXY 和 NO_PROXY。 |
| `resumeArgs`、`parseSessionId` | 可选，使用一个明确的会话 ID 继续同一 CLI 会话。 |

各适配器文件头记录了 argv 和核对状态。Codex 支持结构化输出 schema，Antigravity 使用 CLI 完整模型 ID 表达后缀定义的强度。Claude 的帮助给出的是通用强度选项，实际模型能力取决于后端。OMP 只读取本地 YAML 中的模型元数据。DSH 直读用户 profile 的 `llm-pi-ai` 供应商配置（`~/.dsh/profiles/*/cordis.patch.yml`，desktop 优先）作为模型目录，把选中的那个供应商原样搬进临时 overlay，再加 `agent-default-model`（provider/model/reasoningEffort）；headless 不读托管凭据库，因此 `apiKeyEnv` 先取进程环境、再取 `~/.dsh/.credentials.yaml` 的 `refs` 并通过子进程 env 传入。没有供应商配置时退回 `--dump-config` 读 profile 默认模型。最后一个 `result` 优先作为答案，缺失时使用 assistant 文本。

当 `AGENTS_MCP_FIXTURES=1` 时，注册表只启动离线 fixture。普通运行时，`config.fixtures=true` 可在真实目录中额外注册 fixture。探测有 15 秒预算，失败信息保留在 `agents-cache.json`。滚动更新检测结果可使用 `agents_list` 的 `refresh`。

## MCP 工具

stdio 每行一个 JSON-RPC 消息，日志写入 stderr。HTTP 支持 `POST /mcp`，初始化返回 `Mcp-Session-Id`，后续调用携带该 ID。客户端可用 `DELETE /mcp` 关闭会话。客户端请求中的 `_meta.progressToken` 可触发工具进度通知，`logging/setLevel` 可启用工具日志，HTTP 工具调用可通过事件流返回这两类通知。运行步骤的进度由 `agents_status` 提供。

工具结果同时使用 `structuredContent` 和 JSON 文本。工具错误设置 `isError`，并约定字段 `{code, message, remedy?, details?}`。输入 schema 由 `tools/list` 返回。

| 工具 | 主要参数与结果 |
| --- | --- |
| `agents_list` | `{refresh?}` → `{agents}` |
| `agents_gate` | `{taskId 或 task, decision: "enable" 或 "disable", mode?}` → 授权状态 |
| `agents_flow_plan` | 流程定义 → `{ok, errors, order, warnings}` |
| `agents_flow_run` | 流程定义 → `{runId}` 或授权状态 |
| `agents_delegate` | `{task, taskId?, cwd?, agent, model, effort, writes?, maxDepth?, maxDelegations?, maxParallel?, wallClockMinutes?}` → `{runId}` 或授权状态 |
| `agents_status` | `{runId}` → 步骤状态、事件、产物、报告路径和最终答案 |
| `agents_cancel` | `{runId}` → 取消状态 |
| `agents_draft_role` | `{agent, model, effort, brief, task?, taskId?, cwd?}` → `{runId}` 或授权状态。完成后从状态中读取 `answer`。 |

面板通过 `/api/agents`、`/api/config`、`/api/strengths`、`/api/gate/pending`、`/api/gate`、`/api/flow/validate`、`/api/flow/run`、`/api/delegate`、`/api/runs`、`/api/draft-role`、`/api/presets`、`/api/health`, `/api/bridges` (`GET` 状态 / `POST {id, enabled}` 开关), `/api/calls`, `/api/update`、`/api/shortcuts` 和 `/api/draft-role` 操作同一服务。`POST /api/shutdown` 先回包再关闭监听与服务，`--stop` 与面板「关闭服务」都走它。

## 授权和执行

`ask-once` 将规范化任务文本的 SHA-256 前 16 位用作默认 ID。也可提供一个显式 ID，首次使用时会绑定任务文本。首个请求返回 `confirmation_required`，重复请求引用同一条待授权记录。待授权条目及决定存入 `gate.json`，并带 `createdAt`：超过 24 小时的待授权视为过期，`pending()` 读到时清理，下一次运行重新询问；用户可以 `dismiss` 单条记录，忽略不会留下拒绝决定。决定可由面板或 MCP 提交，写入后不可覆盖。同一个 ID 的决定跨重启有效。模式 A、B 开关独立，策略还支持 `auto-enable` 与 `deny`。职责生成默认直接运行，可以在设置中接入授权。

**模式 A** 使用 `{task, participants, steps, loops?}`。参与者指定 Agent、模型、强度、角色、职责和写入权限。步骤指定参与者、任务、`dependsOn`、`inputs` 和 `produces`。调度器验证有向无环图，再按依赖和并发上限执行。下游通过产物绝对路径与短摘要接收交接。`{from, to, until: "PASS", maxRounds}` 定义评审循环，`maxRounds` 包含首轮。收到 `CHANGES_REQUESTED` 后，评审路径回到上游起点并携带反馈。循环之外的相关下游等待评审通过。子进程运行失败、超时或明确阻塞会结束该分支。运行结束后生成汇总报告。

**模式 B** 给主 Agent 提供任务、可用目录、专长和逐行 `@@AGENTS_MCP delegate {...}` / `@@AGENTS_MCP report {...}` 协议。有效委派占用全局配额。深度、次数、并发和总时限取服务配置与本次请求的较小值。续写使用适配器已识别的会话 ID，缺少该能力时使用有限长度的会话记录。写入权限由启动请求设定，并沿委派树继承。报告列出委派树及主 Agent 给出的工作目录产物引用。原生 MCP 自注册留待后续版本。

## 单文件可执行程序

`scripts/connect.mjs <codex|claude|dsh>` 把本仓库挂进别的 Agent：Codex 走 `codex mcp add`（可选 `--approve` 往 `[mcp_servers.agents-mcp]` 加 `default_tools_approval_mode`），Claude Code 走 `claude mcp add -s <scope>`，DSH 在状态目录下生成一个 carrier bundle（package.json 声明 `dsh.bundle.patch`，patch 插入 `@deepseek-ai/dsh-mcp-client` 行，指向本仓库的 `bin/agents-mcp.js --mcp=stdio`），再调用 `dsh plugin <profile> add` 安装；desktop profile 由 DSH 窗口独占，此时只生成 bundle 并给出从 DSH 界面安装的提示。启动命令里的 node 由 `nodeRuntime()` 解析，所以在打包 exe 里也不会退化成 exe 自身。

`scripts/build-exe.mjs` 用 esbuild 把 `src/app.js` 及其依赖打成一个 CommonJS 文件，再用 Node 的 `--build-sea` 生成 `dist/Agents-MCP.exe`。SEA 不解析相对模块，所以必须打包；面板的 `index.html`、`panel.js`、`panel.css` 作为 SEA assets 内嵌，运行时由 `src/assets.js` 经 `node:sea` 读取，因此 exe 不依赖仓库目录。打包版不包含 fixtures 与测试，`AGENTS_MCP_FIXTURES` 只对源码运行有效。esbuild 仅是开发依赖，运行时仍然只用 Node 标准库。

启动器不写入 Agent 配置，只使用状态目录。端口按配置起点依次尝试 10 个，全部占用时报 `E_PORT`；检测到本服务已在某端口运行时直接打开该页面并退出，实现单实例。失败原因同时写入标准错误和状态目录下的 `launcher.log`。

单文件 exe 里 `process.execPath` 指向 `Agents-MCP.exe`，而 npm 安装的 Agent 通过 `%APPDATA%\npm\*.cmd` 这类 shim 再执行 node。`src/runner/exec.js` 的 `nodeRuntime()` 因此在 SEA 场景改用 `npm_node_execpath` 或 PATH 上的 `node.exe`，否则 shim 会把脚本参数传给本程序并报 “Unknown option”。

工作目录的「浏览…」按钮调用 `POST /api/pick-folder`，服务端用 Windows PowerShell 5.1 的 `-STA` 模式打开 `FolderBrowserDialog`，选中的路径经临时 UTF-8 文件回传（重定向的控制台会丢失非 ASCII 路径）。该接口只在本机同源下可用。

## 状态目录

`src/engine/store.js` 的 `resolveStateDirectory()` 先确认目录可写（探针文件）：`--state-dir` 或 `AGENTS_MCP_HOME` 明确指定但不可写时直接报 `E_STATE_READONLY` 并给出可用命令；默认目录不可写时按 `%LOCALAPPDATA%\Agents-MCP` → `%TEMP%\Agents-MCP` → `~/AppData/Local/Agents-MCP` 依次回退，回退来源经 `GET /api/config` 的 `stateFallback` 暴露给设置页。

```text
config.json
agents-cache.json
gate.json
runs/<run-id>/
  request.md
  flow.json
  steps/<id>.md
  artifacts/
  events.jsonl
  state.json
  report.md
```

`flow.json` 仅用于模式 A。步骤文稿保留最新一轮的提示、思考正文和答案，全量事件按生成顺序存入 JSONL；`reasoning` 事件按步骤累计，单个步骤最多保留 64 KiB，并写入 `steps/<步骤>.md` 的 `# Thinking` 段。事件上的 `usage` 只保留输入、输出和思考 token 数（`inputTokens`/`outputTokens`/`reasoningTokens`），随步骤状态一起暴露给 `agents_status` 和面板。`agents_status` 返回最近 120 条事件（尾部 256 KiB），避免长篇思考挤掉最终答案。记录包含实际工作目录。配置、授权和运行状态使用同目录临时文件与原子重命名。一个状态目录应交由一个服务实例管理。

HTTP 监听 `127.0.0.1`，校验 Host 和 Origin。面板不加载外部资源，文件接口仅允许访问运行目录内的指定文稿。子进程使用所选工作目录与 CLI 权限参数。Windows 用 `taskkill /T /F`，POSIX 向进程组发送终止信号。服务不会写入 Agent 的配置目录，CLI 自身可按其设置维护会话。服务在落盘和返回内容前做密钥脱敏，代理配置拒绝嵌入凭据。
