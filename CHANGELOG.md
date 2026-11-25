# 更新记录

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
