# Agents-MCP

Agents-MCP 是一个本地 MCP 服务，带有网页控制台。它读取已安装 Agent CLI 的模型配置，按任务调度子进程，并保存运行记录和报告。需要 Node.js 22 或更新版本。运行时只使用 Node 标准库。

## 启动

```powershell
node bin/agents-mcp.js                               # stdio MCP
node bin/agents-mcp.js --panel                       # stdio MCP 与本地面板
node bin/agents-mcp.js --mcp=http                     # HTTP MCP 与本地面板
node bin/agents-mcp.js --selftest                     # CLI 与模型目录探测
```

面板默认地址为 `http://127.0.0.1:4870/`，HTTP MCP 使用同一端口的 `/mcp`。MCP 服务名为 `agents`。stdio 主机使用 `node` 作为命令，并将 `bin/agents-mcp.js` 的绝对路径作为参数。

启动参数 `--port N` 可覆盖端口，`--state-dir DIR` 可覆盖状态目录。也可使用 `AGENTS_MCP_HOME`；默认目录在 Windows 是 `%APPDATA%\Agents-MCP`，在其他系统是 `$XDG_STATE_HOME/agents-mcp`，后者回退到 `~/.local/state/agents-mcp`。面板设置里的端口在重启后生效。

## 控制台

- **Agents** 显示探测结果、模型和思考强度。可保存可执行文件路径和每个 Agent 的 HTTP/HTTPS 代理，之后重新检测。
- **模式 A** 选定参与者，填写或生成职责，再定义步骤、依赖和评审循环。成功的步骤可以把产物交给下游。工作目录可以直接输入，也可以点「浏览…」在系统文件夹对话框里选择。
- **模式 B** 指定主 Agent、填写其他 Agent 的专长、设置委派上限。运行记录显示委派树。
- **运行记录** 展示步骤状态、耗时、思考过程、事件、产物和报告，运行期间可取消。
- **设置** 管理任务授权策略、两种模式的开关、端口、默认超时和并发。

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
npm run build:exe        # 输出 dist/Agents-MCP.exe
```

双击 `Agents-MCP.exe` 会在本机启动服务并自动用默认浏览器打开面板 `http://127.0.0.1:4870/`，配置、授权和运行记录都在这个页面里调整。关闭控制台窗口即停止服务。exe 内嵌 Node 运行时和面板资源，可以复制到任意目录单独使用，不需要安装 Node.js，也不需要仓库文件。

- 再次双击不会重复启动：检测到本服务已在运行，只打开已有页面。
- 端口被其他程序占用时，依次向后尝试 10 个端口，全部失败才报错。
- 启动失败的原因同时写入 `%APPDATA%\Agents-MCP\launcher.log`。
- 可选参数：`--port N`、`--state-dir DIR`、`--no-open`（只启动服务、不打开浏览器）、`--check`（只校验可执行文件）。
- exe 未做代码签名，首次运行可能出现 SmartScreen 提示，选择"仍要运行"即可。
- 打包版不含测试 fixture，`AGENTS_MCP_FIXTURES` 只对源码运行有效；Agent 仍按本机 CLI 的实际登录状态探测。
- exe 运行时通过 npm 安装的 Agent（如 `dsh`、`pi`）会改用 PATH 上的 `node` 执行其 shim；缺少 Node.js 时这些 Agent 会显示不可用并提示安装。

## 接入 DSH（MCP）

让 DSH 直接调用这套工具，不用切窗口：

```bash
npm run connect:dsh                        # 生成 bridge bundle 并装进 profile
npm run connect:dsh -- --profile web       # CLI 可管理的 profile
npm run connect:dsh -- --remove            # 卸载
```

- bundle 生成在 `%APPDATA%\Agents-MCP\dsh-bundle`（带绝对路径，所以不放进仓库）。
- `desktop` profile 归 DSH 窗口所有，启动器拒绝命令行安装：脚本会打印 bundle 路径，从 DSH 的插件页选择“从文件夹安装”即可（DSH 自己也能装）。
- 装好后 DSH 会话里多出 `mcp__agents-mcp__agents_list`、`agents_flow_run`、`agents_status` 等工具，和面板共用同一个状态目录，所以在 DSH 里能看到面板上那批运行记录。
- 桥接进程是 `node bin/agents-mcp.js --mcp=stdio`，只开 stdio，不抢占面板端口。

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
