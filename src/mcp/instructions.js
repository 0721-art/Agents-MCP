// What every MCP client is told when it connects. A client shows or forwards this to its
// model, so it is the one place that can say "this server is on, ask once, then tell the user".
export function instructionText({ enabled, gate = {}, modeB = {} } = {}) {
  const state = value => (value === false ? '关' : '开');
  if (enabled === false) {
    return [
      'Agents-MCP 已停用（在面板 header 点「启用 Agents-MCP」后生效）。',
      '停用期间工具仍然列得出来，但每次调用都会返回 E_DISABLED，不会真的启动任何 agent。',
      '如果用户要求使用 Agents-MCP，请先告诉他它现在是停用状态。',
    ].join('\n');
  }
  return [
    'Agents-MCP 已启用（模式 A 编排：' + state(gate.modeA) + '，模式 B 委派：' + state(gate.modeB)
      + '；委派上限 深度 ' + (modeB.maxDepth ?? 2) + ' 层 / ' + (modeB.maxDelegations ?? 12) + ' 次 / 并行 '
      + (modeB.maxParallel ?? 3) + '）。',
    '',
    '约定：',
    '1. 接到任务后，第一次调用 agents_* 之前先用 agents_gate 问一次「是否为此任务启用 Agents-MCP？」，同一任务只问一次（复用同一个 taskId）。',
    '2. 用户同意后，在回复开头明确写一句「Agents-MCP 已启用」，并说明这次用哪种模式。',
    '3. 编排用 agents_flow_plan → agents_flow_run，派活用 agents_delegate，进度看 agents_status，取消用 agents_cancel，代写职责用 agents_draft_role。',
    '4. 不要把 agent 名、模型、思考强度写死：先用 agents_list 读本机实际可用的组合。',
  ].join('\n');
}
