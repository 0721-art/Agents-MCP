import { readFile, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { configWith, defaults, identifier, object, problem } from './config.js';
import { delegationCaps, executeDispatch } from './engine/dispatch.js';
import { executeFlow, validateFlow } from './engine/flow.js';
import { createGate } from './engine/gate.js';
import { createStore, stateDirectory } from './engine/store.js';
import { createRegistry } from './registry/index.js';
import { run } from './runner/exec.js';
import { normalize } from './runner/events.js';

const request = value => {
  if (!object(value)) throw problem('E_INPUT', 'Expected an object.');
  return value;
};
const taskText = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200_000) {
    throw problem('E_TASK', 'Supply task text up to 200000 characters.');
  }
  return value;
};

function inside(root, path) {
  const rel = relative(root, path);
  return rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

export async function createService({ stateDir, env = process.env, cwd = process.cwd() } = {}) {
  const store = await createStore(stateDirectory(stateDir, env), env);
  const configPath = join(store.dir, 'config.json');
  let config = configWith(defaults, await store.readJson(configPath, {}));
  let configWrites = Promise.resolve();
  async function updateConfig(change) {
    const next = configWrites.then(async () => {
      const patch = change(config);
      const validated = configWith(config, patch);
      const clean = store.redact(validated);
      if (JSON.stringify(validated) !== JSON.stringify(clean)) {
        throw problem('E_SECRET_IN_CONFIG', 'Configuration appears to contain credentials.');
      }
      await store.writeJson(configPath, validated);
      config = validated;
      if ('agents' in patch || 'fixtures' in patch) registry.invalidate();
      return config;
    });
    configWrites = next.catch(() => {});
    return next;
  }
  const registry = createRegistry({ store, config: () => config, env });
  const gate = await createGate(store);
  const runs = new Map();
  let closing = false;

  async function start(kind, args, settings, execute) {
    if (closing) throw problem('E_CLOSING', 'The service is shutting down.');
    if (args.cwd !== undefined && (typeof args.cwd !== 'string' || !args.cwd.trim())) {
      throw problem('E_CWD', 'Working directory must be a non-empty path.');
    }
    let target;
    try {
      target = await realpath(resolve(cwd, args.cwd ?? '.'));
      if (!(await stat(target)).isDirectory()) throw new Error('Not a directory.');
    } catch {
      throw problem('E_CWD', 'Target working directory does not exist.', 'Choose an existing local directory.');
    }
    if (closing) throw problem('E_CLOSING', 'The service is shutting down.');
    const id = await store.newRun();
    const root = store.runDir(id);
    const controller = new AbortController();
    const state = { runId: id, kind, task: args.task, cwd: target, status: 'running',
      startedAt: new Date().toISOString(), steps: {}, warnings: [] };
    let writes = Promise.resolve();
    let events = Promise.resolve();
    let eventError;
    const statePath = join(root, 'state.json');
    const save = () => {
      const snapshot = structuredClone(state);
      const next = writes.then(() => store.writeJson(statePath, snapshot));
      writes = next.catch(() => {});
      return next;
    };
    const emit = event => {
      events = events.then(() => store.appendEvent(id, { at: new Date().toISOString(), ...event }))
        .catch(error => { eventError ??= error; });
    };
    const stepPath = step => join(root, 'steps', step + '.md');
    // Reasoning is kept per step so both the panel and the stored transcript can show it.
    const thinking = new Map();
    const transcript = (step, prompt, answer) => {
      const notes = thinking.get(step);
      const section = notes?.text ? '\n\n# Thinking\n\n' + notes.text : '';
      return store.writeText(stepPath(step), '# Prompt\n\n' + prompt + section + '\n\n# Answer\n\n' + answer + '\n');
    };
    const ctx = {
      state, save, registry, config: settings, signal: controller.signal, abort: () => controller.abort(),
      redact: store.redact, stepPath, transcript,
      removeArtifact: path => rm(path, { force: true }),
      async artifact(name, answer) {
        const path = join(root, 'artifacts', name);
        await store.writeText(path, answer + '\n');
        return path;
      },
      async invoke(step, actor, prompt, { schema, sessionId } = {}) {
        const stepState = Object.hasOwn(state.steps, step) ? state.steps[step] : { round: 1 };
        Object.defineProperty(state.steps, step, { value: stepState, enumerable: true, writable: true, configurable: true });
        Object.assign(stepState, { status: 'running', startedAt: new Date().toISOString(), agent: actor.agent,
          model: actor.model, effort: actor.effort });
        await save();
        const started = Date.now();
        const assistant = [];
        let answer;
        let errorText;
        let outcome;
        let promptPath;
        let spec;
        const safePrompt = store.redact(prompt);
        try {
          const { adapter, info, env: childEnv } = await registry.get(actor);
          let schemaPath;
          if (schema && adapter.supportsSchema) {
            schemaPath = join(root, 'steps', step + '.schema.json');
            await store.writeJson(schemaPath, schema);
          }
          if (adapter.usePromptFile) {
            promptPath = join(root, 'steps', step + '.prompt.txt');
            await store.writeText(promptPath, safePrompt);
          }
          const options = { ...actor, cwd: target, permission: actor.writes ? 'write' : 'read',
            prompt: safePrompt, promptPath, schemaPath, sessionId };
          spec = sessionId && adapter.resumeArgs ? adapter.resumeArgs(options) : adapter.buildArgs(options);
          outcome = await run({ ...spec, exe: info.exe, cwd: target, env: childEnv, signal: controller.signal,
            argvPrompt: spec.args.includes(safePrompt),
            timeoutMs: settings.stepTimeoutMinutes * 60_000, onSpawn: pid => {
              stepState.pid = pid;
              emit({ type: 'raw', step, data: { pid, status: 'running' } });
              save().catch(error => { emit({ type: 'error', step, text: error.message }); });
            }, onLine: line => {
              const event = store.redact(normalize(adapter, line));
              emit({ ...event, step });
              if (event.usage) Object.assign(stepState, { tokens: { ...(stepState.tokens ?? {}), ...event.usage } });
              if (event.type === 'reasoning' && typeof event.text === 'string' && event.text) {
                const notes = thinking.get(step) ?? { text: '' };
                const room = 64 * 1024 - notes.text.length;
                if (room > 0) notes.text += (notes.text ? '\n\n' : '') + event.text.slice(0, room);
                thinking.set(step, notes);
              }
              sessionId = adapter.parseSessionId?.(event) || sessionId;
              if (event.type === 'assistant' && typeof event.text === 'string') {
                assistant.push(event.text);
                if (assistant.length > 128) assistant.shift();
              }
              if (event.type === 'result' && typeof event.text === 'string') answer = event.text;
              if (event.type === 'error') {
                errorText = (typeof event.text === 'string' ? event.text : JSON.stringify(event.text))
                  || 'Agent reported an error without a message.';
              }
            } });
          if (outcome.stderrTail.trim() && outcome.code !== 0) emit({ step, type: 'error', text: outcome.stderrTail });
        } catch (error) {
          errorText = store.redact(error.message);
          emit({ type: 'error', step, text: errorText });
        } finally {
          try {
            await spec?.cleanup?.();
          } catch (error) {
            state.warnings.push('Cleanup after step ' + step + ' failed: ' + store.redact(error.message));
          }
          try {
            if (promptPath) await rm(promptPath, { force: true });
          } catch (error) {
            state.warnings.push('Removing the prompt file for step ' + step + ' failed: ' + store.redact(error.message));
          }
        }
        const failed = !outcome || outcome.code !== 0 || outcome.timedOut || outcome.cancelled || Boolean(errorText);
        answer = failed ? (outcome?.cancelled ? 'Cancelled.' : outcome?.timedOut ? 'Step timed out.'
          : errorText || store.redact(outcome?.stderrTail.trim()) || 'Agent exited without success.') : answer ?? assistant.join('\n');
        if (!failed && !answer.trim()) {
          answer = 'CLI returned no usable final answer.';
          emit({ step, type: 'error', text: answer });
        }
        const noAnswer = !failed && answer === 'CLI returned no usable final answer.';
        Object.assign(stepState, { status: failed || noAnswer ? 'FAILED' : 'PASS',
          finishedAt: new Date().toISOString(), durationMs: outcome?.durationMs ?? Date.now() - started });
        await save();
        return { failed: failed || noAnswer, answer, assistant, sessionId };
      },
    };
    if (closing) {
      // newRun() already created runs/<id>/artifacts; drop it instead of leaving an empty run behind.
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
      throw problem('E_CLOSING', 'The service is shutting down.');
    }
    const record = { controller };
    runs.set(id, record);
    const ready = (async () => {
      await store.writeText(join(root, 'request.md'), args.task + '\n');
      if (kind === 'A') await store.writeJson(join(root, 'flow.json'), args);
      await save();
    })();
    record.done = ready.then(async () => {
      let result;
      try {
        result = controller.signal.aborted ? { status: 'cancelled' } : await execute(ctx);
      } catch (error) {
        controller.abort();
        result = { status: 'FAILED', answer: store.redact(error.message) };
        emit({ type: 'error', text: result.answer });
      }
      await events;
      if (eventError) state.warnings.push('Event logging failed: ' + store.redact(eventError.message));
      if (controller.signal.aborted && result.status !== 'FAILED') result.status = 'cancelled';
      const artifacts = (await store.list(join(root, 'artifacts'))).filter(name => name.endsWith('.md'));
      const steps = Object.entries(state.steps).map(([key, step]) => '- ' + key + ' · ' + step.status
        + ' · round ' + step.round + (step.durationMs === undefined ? '' : ' · ' + step.durationMs + ' ms'));
      const report = ['# Agents-MCP report', result.status, '**Working directory** ' + target,
        '## Steps\n\n' + steps.join('\n'),
        artifacts.length && '## Run artifacts\n\n' + artifacts.map(name => '- artifacts/' + name).join('\n'),
        result.paths?.length && '## Workspace artifact references\n\n' + result.paths.map(path => '- ' + path).join('\n'),
        result.delegationTree?.length && '## Delegations\n\n' + result.delegationTree.map(edge =>
          '- ' + edge.parent + ' → ' + edge.id + ' · ' + edge.status).join('\n'),
        state.warnings.length && '## Warnings\n\n' + state.warnings.join('\n'),
        '## Final answer\n\n' + (result.answer || 'No final answer was returned.'),
      ].filter(Boolean).join('\n\n') + '\n';
      await store.writeText(join(root, 'report.md'), report);
      Object.assign(state, result, { finishedAt: new Date().toISOString() });
      await save();
    }).catch(async error => {
      Object.assign(state, { status: 'FAILED', answer: store.redact(error.message), finishedAt: new Date().toISOString() });
      await save().catch(() => {});
      process.stderr.write('Agents-MCP could not finalize run ' + id + ': ' + state.answer + '\n');
    }).finally(() => runs.delete(id));
    await ready;
    return { runId: id };
  }

  const service = {
    redact: store.redact, listAgents: args => registry.list(args), pending: () => gate.pending(),
    gate: args => gate.decide(request(args)), getConfig: () => ({ ...config, stateDir: store.dir }),
    setConfig: patch => updateConfig(() => patch),
    override(id, value) {
      if (!identifier(id) || !object(value)) throw problem('E_CONFIG', 'Invalid executable override.');
      return updateConfig(current => ({ agents: { ...current.agents, [id]: value } }));
    },
    async planFlow(input) {
      const { ok, errors, order, warnings } = await validateFlow(request(input), registry);
      return { ok, errors, order, warnings };
    },
    async runFlow(input) {
      const args = request(input);
      taskText(args.task);
      const settings = config;
      const decision = await gate.check({ ...args, mode: 'A' }, settings.gate);
      if (decision.status !== 'enabled') return decision;
      const plan = await validateFlow(args, registry);
      if (!plan.ok) {
        const first = plan.errors[0];
        const error = problem(first.code || 'E_FLOW', first.path + ': ' + first.message, first.remedy);
        error.details = plan.errors;
        throw error;
      }
      return start('A', args, settings, ctx => executeFlow(ctx, args, plan));
    },
    async delegate(input) {
      const args = request(input);
      taskText(args.task);
      if (args.writes !== undefined && typeof args.writes !== 'boolean') throw problem('E_INPUT', 'writes must be a boolean.');
      const settings = config;
      const decision = await gate.check({ ...args, mode: 'B' }, settings.gate);
      if (decision.status !== 'enabled') return decision;
      const caps = delegationCaps(settings, args);
      await registry.get(args);
      return start('B', args, settings, async ctx => {
        ctx.state.caps = caps;
        let expired = false;
        const timer = setTimeout(() => {
          expired = true;
          ctx.state.warnings.push('Delegation reached its wall-clock time limit.');
          runs.get(ctx.state.runId)?.controller.abort();
        }, caps.wallClockMinutes * 60_000);
        try {
          const result = await executeDispatch(ctx, args, caps);
          return expired ? { ...result, status: 'FAILED' } : result;
        } finally {
          clearTimeout(timer);
        }
      });
    },
    async draftRole(input) {
      const args = request(input);
      taskText(args.brief);
      const task = taskText(args.task ?? args.brief);
      const settings = config;
      if (settings.gate.draftRoleRequiresGate) {
        const decision = await gate.check({ task, taskId: args.taskId }, settings.gate);
        if (decision.status !== 'enabled') return decision;
      }
      await registry.get(args);
      return start('draft', { ...args, task }, settings, async ctx => {
        const prompt = 'Expand this brief into a practical responsibility for one agent. Return only the responsibility.\n\n' + args.brief;
        const result = await ctx.invoke('draft', { ...args, writes: false }, prompt);
        await ctx.transcript('draft', prompt, result.answer);
        return { status: ctx.signal.aborted ? 'cancelled' : result.failed ? 'FAILED' : 'PASS', answer: result.answer };
      });
    },
    async status({ runId } = {}) {
      const directory = store.runDir(runId);
      const state = await store.readState(runId);
      if (!state) throw problem('E_RUN_NOT_FOUND', 'Run not found.');
      return { ...state, directory, reportPath: await store.hasReport(runId) ? join(directory, 'report.md') : null,
        events: await store.recentEvents(runId), artifacts: (await store.list(join(directory, 'artifacts'))).filter(name => name.endsWith('.md')) };
    },
    async listRuns() {
      const ids = (await store.list(join(store.dir, 'runs'))).filter(id => /^\d{8}-\d{6}-[a-f0-9]{6}$/.test(id)).sort().reverse();
      return (await Promise.all(ids.map(id => store.readState(id)))).filter(Boolean)
        .map(({ runId, task, kind, status, cwd, startedAt, finishedAt }) => ({ runId, task, kind, status, cwd, startedAt, finishedAt }));
    },
    async cancel({ runId } = {}) {
      const directory = store.runDir(runId);
      const active = runs.get(runId);
      if (active) {
        active.controller.abort();
        return { runId, status: 'cancelling' };
      }
      const state = await store.readState(runId);
      if (!state) throw problem('E_RUN_NOT_FOUND', 'Run not found: ' + directory);
      return { runId, status: state.status };
    },
    async runFile(runId, file) {
      if (!/^(?:report\.md|request\.md|(?:artifacts|steps)\/[a-z0-9_-]+\.md)$/i.test(file)) {
        throw problem('E_FILE', 'Run file is not available.');
      }
      try {
        const root = await realpath(store.runDir(runId));
        const path = await realpath(join(root, file));
        if (!inside(root, path) || !(await stat(path)).isFile()) throw new Error('Not a run file.');
        return store.redact(await readFile(path, 'utf8'));
      } catch {
        throw problem('E_FILE', 'Run file is not available.');
      }
    },
    async close() {
      closing = true;
      const active = [...runs.values()];
      active.forEach(record => record.controller.abort());
      await Promise.all(active.map(record => record.done));
    },
  };
  return service;
}
