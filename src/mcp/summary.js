// The text copy of a tool result is what a model actually reads; `structuredContent` carries
// the same data. For big answers (a full agent catalogue, a long run record) sending both in
// full doubles the tokens for nothing, so above this size the text becomes a summary.

export const textLimit = 4000;

const bytes = value => Buffer.byteLength(value, 'utf8');

const stepList = steps => Object.entries(steps ?? {})
  .map(([id, step]) => `${id}=${step?.status ?? 'pending'}`)
  .join(' ');

const statuses = { PASS: '完成', FAILED: '失败', BLOCKED: '受阻', CHANGES_REQUESTED: '待修改',
  SKIPPED: '已跳过', cancelled: '已取消', incomplete: '未完成', refused: '已拒绝', running: '运行中' };
const statusLabel = status => statuses[status] ?? status;
const actor = (agent, step) => `${agent} · ${step}`;

export function collaborationMessage(event) {
  const step = actor(event.agent, event.step);
  const route = `${actor(event.fromAgent, event.from)} → ${actor(event.toAgent, event.to)}`;
  const round = event.round > 1 ? ` · 第 ${event.round} 轮` : '';
  const status = statusLabel(event.status);
  switch (event.kind) {
    case 'run_started': return event.mode === 'draft' ? '开始生成职责' : `开始运行 · 模式 ${event.mode}`;
    case 'run_finished': return `运行${status}`;
    case 'step_started': return `${step} 开始工作${round}`;
    case 'progress': return `${step} 更新进展${round}`;
    case 'step_finished': {
      const result = event.mode === 'B' && event.status === 'PASS' ? '已回复' : status;
      const tokens = event.reasoningTokens === undefined ? '' : ` · 思考 ${event.reasoningTokens} tokens`;
      return `${step} ${result}${round}${tokens}`;
    }
    case 'handoff': return `${route} · 传递产物${round}`;
    case 'review': return `${route} · 退回修改${round}`;
    case 'delegate': return `${route} · 委派任务`;
    case 'delegation_result': return `${route} · 返回结果 · ${status}`;
    default: return event.kind;
  }
}

const short = (tool, data) => {
  if (tool === 'agents_list' && Array.isArray(data?.agents)) {
    const rows = data.agents.slice(0, 8).map(agent => (agent.available
      ? `${agent.id} 可用（${agent.models?.length ?? 0} 模型）`
      : `${agent.id} 不可用${agent.reason ? `：${agent.reason}` : ''}`));
    const more = data.agents.length > rows.length ? `；等 ${data.agents.length} 个` : '';
    return `${data.agents.length} 个 agent：${rows.join('；')}${more}。完整模型与思考强度见 structuredContent。`;
  }
  if (tool === 'agents_status' && data?.runId) {
    if (data.timelineCursor !== undefined) {
      const brief = (value, length) => {
        const text = value.replace(/\s+/g, ' ');
        return text.length > length ? text.slice(0, length) + '…' : text;
      };
      const messages = data.timeline.map(event => `- ${brief(event.message, 115)}`
        + (event.detail ? `\n  ${brief(event.detail, 125)}` : ''));
      return [`运行 ${data.runId} · ${statusLabel(data.status)} · 协作消息游标 ${data.timelineCursor}`
        + (data.timelineHasMore ? ' · 还有未读消息' : ''),
      ...(messages.length ? messages : ['暂无新协作消息。']),
      ...(data.answer && !data.timelineHasMore ? ['最终结果', brief(data.answer, 450)] : [])].join('\n');
    }
    const steps = stepList(data.steps);
    return `运行 ${data.runId}：${data.status ?? '进行中'}${data.round ? `，第 ${data.round} 轮` : ''}`
      + `${steps ? `；步骤 ${steps}` : ''}；事件 ${data.events?.length ?? 0} 条，产物 ${Object.keys(data.artifacts ?? {}).length} 个。`
      + '协作消息用 after=0 开始读取，完整状态见 structuredContent。';
  }
  if (tool === 'agents_flow_plan') {
    const errors = data?.errors?.length ?? 0;
    const order = Array.isArray(data?.order) && data.order.length ? `：${data.order.join(' → ')}` : '';
    return `${data?.ok ? '流程可用' : `流程有 ${errors} 处问题`}${order}。详细结果见 structuredContent。`;
  }
  if (tool === 'agents_delegate' && data?.runId) {
    return `已开始委派运行 ${data.runId}${data.status ? `（${data.status}）` : ''}。进度用 agents_status 查看。`;
  }
  if (tool === 'agents_flow_run' && data?.runId) {
    return `已开始运行 ${data.runId}${data.status ? `（${data.status}）` : ''}。进度用 agents_status 查看。`;
  }
  return `返回 ${bytes(JSON.stringify(data ?? null))} 字节的 JSON，内容见 structuredContent。`;
};

// Keep the sentence the agent must repeat even when the payload itself is dropped.
export function summarize(tool, data) {
  const line = short(tool, data);
  const tellUser = data?.tellUser;
  return (tellUser ? `${line}\n${tellUser}` : line).slice(0, textLimit);
}
