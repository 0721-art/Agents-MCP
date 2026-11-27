import { fileIdentifier, identifier, integer, object } from '../config.js';

const text = value => typeof value === 'string' && Boolean(value.trim());
const named = value => value === undefined || (Array.isArray(value) && value.every(identifier)
  && new Set(value).size === value.length);

function topo(steps, deps) {
  const remaining = new Set(steps.map(step => step.id));
  const order = [];
  while (remaining.size) {
    const ready = [...remaining].filter(id => deps.get(id).every(parent => !remaining.has(parent)));
    if (!ready.length) break;
    ready.forEach(id => remaining.delete(id));
    order.push(...ready);
  }
  return order;
}

function ancestors(id, deps, result = new Set()) {
  for (const parent of deps.get(id) ?? []) {
    if (result.has(parent)) continue;
    result.add(parent);
    ancestors(parent, deps, result);
  }
  return result;
}

export async function validateFlow(def, registry) {
  const errors = [];
  const add = (path, message, code, remedy) => errors.push({ path, message, code, remedy });
  const list = key => {
    const value = def?.[key];
    if (!Array.isArray(value) || (key !== 'loops' && !value.length) || value.length > 100) {
      add(key, 'Expected ' + (key === 'loops' ? '0' : '1') + '–100 rows.');
      return [];
    }
    return value;
  };
  if (!text(def?.task)) add('task', 'Task text is required.');
  const participants = new Map();
  const participantRows = list('participants');
  participantRows.forEach((row, i) => {
    const path = 'participants[' + i + ']';
    if (!identifier(row?.id) || participants.has(row.id)) return add(path + '.id', 'Participant ID must be unique.');
    participants.set(row.id, row);
    for (const key of ['agent', 'model', 'effort']) {
      if (!text(row[key])) add(path + '.' + key, 'Specify ' + key + '.');
    }
    for (const key of ['role', 'responsibility']) {
      if (row[key] !== undefined && typeof row[key] !== 'string') add(path + '.' + key, 'Expected text.');
    }
    if (row.writes !== undefined && typeof row.writes !== 'boolean') add(path + '.writes', 'Expected a boolean.');
  });
  const steps = new Map();
  const deps = new Map();
  const files = new Set();
  const stepIds = new Set();
  list('steps').forEach((row, i) => {
    const path = 'steps[' + i + ']';
    if (!fileIdentifier(row?.id) || stepIds.has(row.id.toLowerCase())) {
      return add(path + '.id', 'Step ID must be unique and usable as a filename.');
    }
    stepIds.add(row.id.toLowerCase());
    steps.set(row.id, row);
    if (!participants.has(row.participant)) add(path + '.participant', 'Unknown participant.');
    if (!text(row.task)) add(path + '.task', 'Step task is required.');
    for (const key of ['dependsOn', 'inputs', 'produces']) {
      if (!named(row[key])) add(path + '.' + key, 'Expected unique identifiers.');
    }
    if (named(row.produces)) {
      for (const name of row.produces ?? []) {
        const file = (row.id + '-' + name).toLowerCase();
        if (files.has(file)) add(path + '.produces', 'Artifact filename collides with another produces entry.');
        files.add(file);
      }
    }
    deps.set(row.id, named(row.dependsOn) ? row.dependsOn ?? [] : []);
  });
  for (const [id, parents] of deps) {
    for (const parent of parents) if (!steps.has(parent)) add('steps.' + id + '.dependsOn', 'Unknown dependency ' + parent + '.');
  }
  const rows = [...steps.values()];
  const order = topo(rows, deps);
  if (order.length !== rows.length) add('steps', 'Dependency cycle detected.');
  const loops = new Map();
  const effective = new Map([...deps].map(([id, parents]) => [id, [...parents]]));
  for (const [i, loop] of (def?.loops === undefined ? [] : list('loops')).entries()) {
    const path = 'loops[' + i + ']';
    if (!object(loop) || !steps.has(loop.from) || !steps.has(loop.to) || loop.from === loop.to
      || !ancestors(loop.from, deps).has(loop.to) || loops.has(loop.from)) {
      add(path, 'Use a unique reviewer and one of its upstream steps.');
      continue;
    }
    if (loop.until !== 'PASS' || !integer(loop.maxRounds, 1, 10)) {
      add(path, 'Use until PASS and maxRounds between 1 and 10.');
      continue;
    }
    const source = ancestors(loop.from, deps);
    const region = new Set(order.filter(id => id === loop.from || id === loop.to
      || (source.has(id) && ancestors(id, deps).has(loop.to))));
    // ponytail: shared steps need loop-scoped feedback and retry counters before overlaps can run.
    const overlap = [...loops.values()].find(prior => [...region].some(id => prior.region.has(id)));
    if (overlap) {
      add(path, 'Review regions overlap for ' + loop.from + ' and ' + overlap.from + '. Use disjoint review regions.');
      continue;
    }
    loops.set(loop.from, { ...loop, region });
    for (const [id, parents] of deps) {
      if (!region.has(id) && parents.some(parent => region.has(parent))) effective.get(id).push(loop.from);
    }
  }
  const effectiveOrder = topo(rows, effective);
  if (order.length === rows.length && effectiveOrder.length !== rows.length) {
    add('loops', 'Review barriers form a dependency cycle. Keep consumers of revised steps downstream of the reviewer.');
  }
  await Promise.all([...participants.values()].map(async row => {
    if (![row.agent, row.model, row.effort].every(text)) return;
    try {
      await registry.get(row);
    } catch (error) {
      add('participants.' + row.id, error.message, error.code, error.remedy);
    }
  }));
  return { ok: errors.length === 0, errors, order: effectiveOrder, warnings: [], steps, participants, deps, effective, loops };
}

function verdict(answer, reviewer) {
  try {
    const parsed = JSON.parse(answer);
    if (['PASS', 'CHANGES_REQUESTED', 'BLOCKED'].includes(parsed.status) && typeof parsed.report === 'string') {
      return { status: parsed.status, answer: parsed.report };
    }
  } catch {
    // Plain-text adapters use a final verdict line.
  }
  const match = answer.match(/(?:^|\r?\n)VERDICT:\s*(PASS|CHANGES_REQUESTED|BLOCKED)\s*$/);
  return { status: match?.[1] ?? (reviewer ? 'CHANGES_REQUESTED' : 'PASS'),
    answer: match ? answer.slice(0, match.index).trim() : answer,
    warning: !match && reviewer ? 'Reviewer returned no explicit verdict.' : undefined };
}

export const verdictSchema = {
  type: 'object', additionalProperties: false, required: ['status', 'report'],
  properties: { status: { enum: ['PASS', 'CHANGES_REQUESTED', 'BLOCKED'] }, report: { type: 'string' } },
};

export async function executeFlow(ctx, flow, plan) {
  const { steps, participants, effective, loops, deps, order } = plan;
  const actorFor = id => participants.get(steps.get(id).participant);
  const pendingStep = (id, round) => {
    const { agent, model, effort, role } = actorFor(id);
    return { status: 'pending', round, position: order.indexOf(id), agent, model, effort, role: role?.trim().slice(0, 120),
      task: steps.get(id).task.trim().slice(0, 240) };
  };
  const pending = new Set(order);
  const active = new Map();
  const answers = new Map();
  const artifacts = new Map();
  const feedback = new Map();
  const rounds = new Map([...loops.keys()].map(id => [id, 1]));
  let exhausted = false;
  for (const id of order) ctx.state.steps[id] = pendingStep(id, 1);
  await ctx.save();

  async function execute(id) {
    const step = steps.get(id);
    const actor = actorFor(id);
    const round = ctx.state.steps[id].round;
    const filesByContent = new Map();
    for (const parent of ancestors(id, deps)) {
      const entries = (artifacts.get(parent) ?? []).filter(entry => !step.inputs?.length || step.inputs.includes(entry.name));
      if (!entries.length) continue;
      ctx.note({ kind: 'handoff', from: parent, fromAgent: actorFor(parent).agent, to: id, toAgent: actor.agent, round },
        entries.map(entry => entry.file).join('\n'));
      const answer = answers.get(parent);
      const files = filesByContent.get(answer) ?? [];
      files.push(...entries);
      filesByContent.set(answer, files);
    }
    // The text travels with the prompt: a sandboxed agent may only read inside its working
    // directory, and a handoff it cannot read is a handoff that never happened.
    const attachments = [...filesByContent].map(([answer, files]) => {
      const text = answer.slice(0, 24_000) + (answer.length > 24_000 ? '\n\n…(truncated)' : '');
      const labels = files.map(entry => entry.name + ' — ' + entry.path);
      const heading = '### Files with identical content:\n';
      if (labels.length > 1 && text.length >= heading.length) {
        return heading + labels.map(label => '- ' + label).join('\n') + '\n\n' + text;
      }
      return labels.map(label => '### ' + label + '\n' + text).join('\n\n');
    }).join('\n\n');
    const prompt = ['Task:\n' + flow.task, 'Step:\n' + step.task, 'Role: ' + (actor.role || actor.id),
      actor.responsibility && 'Responsibility:\n' + actor.responsibility, attachments && 'Upstream artifacts:\n' + attachments,
      feedback.get(id) && 'Reviewer feedback:\n' + feedback.get(id),
      '面向用户的回复、进展摘要、评审反馈和交接说明请使用简体中文。代码、文件名和协议字段保留原样。',
      'Finish with a final line: VERDICT: PASS, VERDICT: CHANGES_REQUESTED, or VERDICT: BLOCKED. If a response schema is supplied, use its status and report fields.',
    ].filter(Boolean).join('\n\n');
    const result = await ctx.invoke(id, actor, prompt, { schema: verdictSchema, task: step.task });
    const final = result.failed ? { status: 'FAILED', answer: result.answer } : verdict(result.answer, loops.has(id));
    if (final.warning) ctx.state.warnings.push(id + ': ' + final.warning);
    await ctx.transcript(id, prompt, final.answer);
    answers.set(id, final.answer);
    if (final.status === 'PASS') {
      const entries = [];
      for (const name of step.produces ?? []) {
        const file = id + '-' + name + '.md';
        const path = await ctx.artifact(file, final.answer);
        entries.push({ name, file, path });
      }
      artifacts.set(id, entries);
    }
    ctx.state.steps[id].status = final.status;
    ctx.note({ kind: 'step_finished', step: id, agent: actor.agent, round,
      status: ctx.signal.aborted && result.failed ? 'cancelled' : final.status,
      reasoningTokens: ctx.state.steps[id].tokens?.reasoningTokens }, final.answer);
    const loop = loops.get(id);
    if (loop && final.status === 'CHANGES_REQUESTED' && !ctx.signal.aborted) {
      const used = rounds.get(id);
      if (used === loop.maxRounds) exhausted = true;
      else {
        rounds.set(id, used + 1);
        feedback.set(loop.to, final.answer);
        await Promise.all([...loop.region].flatMap(key => (artifacts.get(key) ?? []).map(entry => ctx.removeArtifact(entry.path))));
        ctx.note({ kind: 'review', from: id, fromAgent: actor.agent, to: loop.to, toAgent: actorFor(loop.to).agent,
          round: ctx.state.steps[loop.to].round + 1 }, final.answer);
        for (const key of loop.region) {
          pending.add(key);
          ctx.state.steps[key] = pendingStep(key, ctx.state.steps[key].round + 1);
          artifacts.delete(key);
          answers.delete(key);
        }
      }
    }
    await ctx.save();
  }

  try {
    while ((pending.size || active.size) && !ctx.signal.aborted) {
      for (const id of pending) {
        if (active.size >= ctx.config.maxParallel) break;
        const parents = effective.get(id);
        if (active.has(id) || parents.some(parent => active.has(parent) || pending.has(parent))) continue;
        pending.delete(id);
        const stopped = parents.filter(parent => ctx.state.steps[parent].status !== 'PASS');
        if (stopped.length) {
          ctx.state.steps[id].status = 'SKIPPED';
          ctx.note({ kind: 'step_finished', step: id, agent: actorFor(id).agent, round: ctx.state.steps[id].round,
            status: 'SKIPPED' }, '依赖未通过 · ' + stopped.join('、'));
          continue;
        }
        active.set(id, execute(id).then(() => ({ id }), error => ({ id, error })));
      }
      if (active.size) {
        const { id, error } = await Promise.race(active.values());
        active.delete(id);
        if (error) throw error;
      } else if (pending.size && ![...pending].some(id => effective.get(id).every(parent => !pending.has(parent)))) {
        throw new Error('Flow has no runnable step.');
      }
    }
  } finally {
    if (active.size && !ctx.signal.aborted) ctx.abort();
    await Promise.all(active.values());
    for (const id of pending) ctx.state.steps[id].status = 'SKIPPED';
  }
  const statuses = Object.values(ctx.state.steps).map(step => step.status);
  const status = ctx.signal.aborted ? 'cancelled' : statuses.includes('FAILED') ? 'FAILED'
    : statuses.includes('BLOCKED') ? 'BLOCKED' : exhausted || statuses.includes('CHANGES_REQUESTED') ? 'incomplete' : 'PASS';
  const upstream = new Set([...effective.values()].flat());
  const answer = order.filter(id => !upstream.has(id) && answers.has(id)).map(id => answers.get(id)).at(-1)
    ?? [...answers.values()].at(-1) ?? '';
  return { status, answer, loopRounds: Object.fromEntries(rounds) };
}
