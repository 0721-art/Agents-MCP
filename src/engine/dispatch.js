import { integer, object, problem } from '../config.js';

export function delegationCaps(config, input) {
  const limits = { maxDepth: 10, maxDelegations: 100, maxParallel: 32, wallClockMinutes: 1440 };
  return Object.fromEntries(Object.entries(limits).map(([key, max]) => {
    if (input[key] !== undefined && !integer(input[key], 1, max)) throw problem('E_CAP', 'Invalid ' + key + '.');
    return [key, Math.min(config.modeB[key], input[key] ?? Infinity, key === 'maxParallel' ? config.maxParallel : Infinity)];
  }));
}

export function parseBlocks(answer) {
  const blocks = [];
  for (const line of answer.split(/\r?\n/)) {
    const match = line.match(/^@@AGENTS_MCP (delegate|report)\s+([\s\S]*)$/);
    if (!match) continue;
    try {
      const data = JSON.parse(match[2]);
      if (!object(data)) throw new Error('Expected an object.');
      blocks.push({ kind: match[1], data });
    } catch {
      blocks.push({ kind: 'invalid' });
    }
  }
  return blocks;
}

const protocol = [
  'Use one line for each delegation. Wait for the results before writing a final report.',
  '@@AGENTS_MCP delegate {"to":"agent-id","model":"model-id","effort":"effort","task":"subtask"}',
  '@@AGENTS_MCP report {"summary":"final answer","artifacts":["workspace-relative path"]}',
].join('\n');

export async function executeDispatch(ctx, input, caps) {
  const tree = ctx.state.delegationTree = [];
  const roster = (await ctx.registry.list()).filter(info => info.available).map(info =>
    info.id + ': ' + (Object.hasOwn(ctx.config.strengths, info.id) ? ctx.config.strengths[info.id] + ' | ' : '')
    + info.models.map(model => model.id + ' (' + model.efforts.join('/') + ')').join(', ')).join('\n');
  const queue = [];
  let active = 0;
  let count = 0;
  function take() {
    while (queue.length && active < caps.maxParallel) {
      const { action, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(action).then(resolve, reject).finally(() => { active--; take(); });
    }
  }
  const limited = action => new Promise((resolve, reject) => {
    queue.push({ action, resolve, reject });
    take();
  });
  async function actorLoop(actor, id, depth, task) {
    const first = ['Task:\n' + task, depth < caps.maxDepth && 'Available agents:\n' + roster,
      depth < caps.maxDepth && protocol].filter(Boolean).join('\n\n');
    let prompt = first;
    let sessionId;
    let answer = '';
    let history = '';
    const { adapter } = await ctx.registry.get(actor);
    for (let round = 1; round <= caps.maxDelegations + 2 && !ctx.signal.aborted; round++) {
      const step = round === 1 ? id : id + '-r' + round;
      const result = await limited(() => ctx.invoke(step, actor, prompt, { sessionId }));
      answer = result.answer;
      await ctx.transcript(step, prompt, answer);
      if (result.failed) return { status: 'FAILED', answer };
      sessionId = result.sessionId || sessionId;
      let blocks = parseBlocks(answer);
      if (!blocks.length) blocks = parseBlocks(result.assistant.join('\n'));
      const delegates = blocks.filter(block => block.kind !== 'report');
      if (!delegates.length) {
        const report = blocks.findLast(block => block.kind === 'report')?.data;
        const paths = Array.isArray(report?.artifacts) ? report.artifacts.filter(path => typeof path === 'string') : [];
        return { status: 'PASS', answer: typeof report?.summary === 'string' ? report.summary : answer, paths };
      }
      const results = await Promise.all(delegates.map(async block => {
        if (block.kind === 'invalid') return 'DELEGATION_REFUSED: malformed JSON block';
        if (depth >= caps.maxDepth) return 'DELEGATION_REFUSED: depth cap reached';
        const data = block.data;
        const worker = { agent: data.to, model: data.model, effort: data.effort, writes: actor.writes };
        if (![data.to, data.model, data.effort, data.task].every(value => typeof value === 'string' && value.trim())) {
          return 'DELEGATION_REFUSED: to, model, effort and task are required';
        }
        if (count >= caps.maxDelegations) return 'DELEGATION_REFUSED: delegation cap reached';
        try {
          await ctx.registry.get(worker);
        } catch (error) {
          return 'DELEGATION_REFUSED: ' + ctx.redact(error.message);
        }
        if (count >= caps.maxDelegations) return 'DELEGATION_REFUSED: delegation cap reached';
        // Reserve without awaiting so concurrent branches cannot exceed the cap.
        const childId = 'd' + (++count) + '-' + data.to.replace(/[^a-z0-9_-]/gi, '').slice(0, 24);
        const edge = { id: childId, parent: id, agent: data.to, status: 'running' };
        tree.push(edge);
        ctx.state.delegations = count;
        await ctx.save();
        try {
          const child = await actorLoop(worker, childId, depth + 1, data.task);
          edge.status = child.status;
          return childId + ' ' + child.status + ' (' + ctx.stepPath(childId) + ')\n' + child.answer;
        } catch (error) {
          edge.status = 'refused';
          return 'DELEGATION_REFUSED: ' + ctx.redact(error.message);
        } finally {
          await ctx.save();
        }
      }));
      const continuation = 'Delegation results:\n' + results.join('\n\n') + '\n\n' + protocol;
      if (sessionId && adapter.resumeArgs) {
        prompt = continuation;
      } else {
        if (!ctx.state.warnings.includes('A CLI continued using a transcript in a new session.')) {
          ctx.state.warnings.push('A CLI continued using a transcript in a new session.');
        }
        history += '\n\nAssistant:\n' + answer + '\n\n' + continuation;
        // ponytail: retain a bounded conversation tail; use resumable sessions for longer context.
        prompt = first + '\n\nPrevious conversation:\n' + history.slice(-128_000);
      }
    }
    return { status: ctx.signal.aborted ? 'cancelled' : 'incomplete', answer };
  }
  const result = await actorLoop(input, 'main', 0, input.task);
  return { ...result, delegationTree: tree };
}
