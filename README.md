# Agents-MCP

Standalone [MCP](https://modelcontextprotocol.io) server plus a local panel that lets one AI agent
orchestrate the other agent CLIs installed on this machine — Codex, Antigravity, Claude Code, DSH,
Pi, OMP, Grok — each at its own model and reasoning effort.

> Status: under active development. The contract below is the target; see `docs/` for what is
> implemented today.

## Why

Every agent CLI on this machine is good at something different, and each keeps its own model
catalog and reasoning-effort levels. Agents-MCP turns them into one addressable roster:

- it **detects** the installed agents and reads each one's own config to know which models and
  effort levels it really supports;
- it **runs** them as subprocesses in a target working directory, streaming their events;
- it **hands work off** between them, either along a flow you design or by letting one main agent
  dispatch freely;
- and it asks you **once per task** whether this server should be in charge.

## Two modes

**Mode A — orchestration.** You pick participants (`agent` + `model` + `effort`), write or have the
LLM expand each one's responsibility, then arrange the flow: steps, dependencies, hand-off
artifacts, review loops. The server executes that graph.

**Mode B — delegation.** You designate a main agent. It receives the task plus the roster and
dispatches to the others by itself, then reports back. The server enforces depth and fan-out limits
and records the whole task tree.

Both modes can be switched on or off independently. Before the first run of a task the server asks
the user once — never again for that task.

## Surfaces

- **MCP** over stdio (default) and streamable HTTP, so any MCP host can use it.
- **Panel**: a local web UI served by the same process — agent health, model/effort selection,
  responsibilities, flow editor, live run monitor, and the enable-once gate.

## Getting started

```bash
git clone https://github.com/0721-art/Agents-MCP.git
cd Agents-MCP
node bin/agents-mcp.js          # MCP server on stdio
node bin/agents-mcp.js --panel  # also open the panel
```

Requires Node.js 22 or newer and at least one supported agent CLI on `PATH` or in its default
install location.

## Agents

| Agent        | Detected as              | Models from                       | Effort                      |
| ------------ | ------------------------ | --------------------------------- | --------------------------- |
| Codex        | `codex` appx / `codex`   | `~/.codex/models_cache.json`      | `model_reasoning_effort`    |
| Antigravity  | `agy`                    | `agy models`                      | `--effort`                  |
| Claude Code  | `claude`                 | configured aliases + catalog      | `--effort`                  |
| Pi           | `pi`                     | `~/.pi/agent/models.json`         | `--thinking`                |
| OMP          | `omp`                    | `omp` config + models             | `--thinking`                |
| Grok         | `grok`                   | `grok models`                     | effort flag                 |
| DSH          | `DeepSeek Harness`       | profile config (`dsh-llm-pi-ai`)  | provider effort map         |

Adapters are declarative: an agent is a JSON/YAML record describing its executable, its model
catalog probe, its argv builder and its output parser. Adding an agent should not require touching
the engine.

## License

MIT
