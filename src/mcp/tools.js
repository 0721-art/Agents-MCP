const string = { type: 'string' };
const boolean = { type: 'boolean' };
const integer = { type: 'integer', minimum: 1 };
const mode = { enum: ['A', 'B'] };
const actor = { agent: string, model: string, effort: string };
const task = { task: string, taskId: string, cwd: string };
const record = (properties, required = []) => ({ type: 'object', properties, required });
const array = items => ({ type: 'array', items });
const flow = record({
  ...task,
  participants: array(record({ id: string, ...actor, role: string, responsibility: string, writes: boolean },
    ['id', 'agent', 'model', 'effort'])),
  steps: array(record({ id: string, participant: string, task: string, dependsOn: array(string),
    inputs: array(string), produces: array(string) }, ['id', 'participant', 'task'])),
  loops: array(record({ from: string, to: string, until: { const: 'PASS' }, maxRounds: integer },
    ['from', 'to', 'until', 'maxRounds'])),
}, ['task', 'participants', 'steps']);

export function toolMap(service) {
  return new Map([
    ['agents_list', 'List agent health, models and reasoning efforts.', record({ refresh: boolean }),
      async args => ({ agents: await service.listAgents(args) })],
    ['agents_gate', 'Record the human enable or disable decision for a task.', record({
      task: string, taskId: string, decision: { enum: ['enable', 'disable'] }, mode,
    }, ['decision']), service.gate],
    ['agents_flow_plan', 'Validate a Mode A flow and preview its order.', flow, service.planFlow],
    ['agents_flow_run', 'Start Mode A after the task gate and return its run ID.', flow, service.runFlow],
    ['agents_delegate', 'Start capped Mode B delegation after the task gate.', record({
      ...task, ...actor, writes: boolean, maxDepth: integer, maxDelegations: integer, maxParallel: integer, wallClockMinutes: integer,
    }, ['task', 'agent', 'model', 'effort']), service.delegate],
    ['agents_status', 'Read step statuses, events, artifacts and report path.', record({ runId: string }, ['runId']), service.status],
    ['agents_cancel', 'Cancel a run and terminate its active processes.', record({ runId: string }, ['runId']), service.cancel],
    ['agents_draft_role', 'Start a responsibility-drafting run and read its answer with agents_status.', record({
      ...actor, ...task, brief: string,
    }, ['agent', 'model', 'effort', 'brief']), service.draftRole],
  ].map(([name, description, inputSchema, call]) => [name, { name, description, inputSchema, call }]));
}
