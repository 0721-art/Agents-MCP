// The text copy of a tool result is what a model actually reads; `structuredContent` carries
// the same data. For big answers (a full agent catalogue, a long run record) sending both in
// full doubles the tokens for nothing, so above this size the text becomes a summary.

export const textLimit = 4000;

const bytes = value => Buffer.byteLength(value, 'utf8');

const stepList = steps => Object.entries(steps ?? {})
  .map(([id, step]) => `${id}=${step?.status ?? 'pending'}`)
  .join(' ');

const short = (tool, data) => {
  if (tool === 'agents_list' && Array.isArray(data?.agents)) {
    const rows = data.agents.slice(0, 8).map(agent => (agent.available
      ? `${agent.id} 可用（${agent.models?.length ?? 0} 模型）`
      : `${agent.id} 不可用${agent.reason ? `：${agent.reason}` : ''}`));
    const more = data.agents.length > rows.length ? `；等 ${data.agents.length} 个` : '';
    return `${data.agents.length} 个 agent：${rows.join('；')}${more}。完整模型与思考强度见 structuredContent。`;
  }
  if (tool === 'agents_status' && data?.runId) {
    const steps = stepList(data.steps);
    return `运行 ${data.runId}：${data.status ?? '进行中'}${data.round ? `，第 ${data.round} 轮` : ''}`
      + `${steps ? `；步骤 ${steps}` : ''}；事件 ${data.events?.length ?? 0} 条，产物 ${Object.keys(data.artifacts ?? {}).length} 个。`
      + '完整记录见 structuredContent。';
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
