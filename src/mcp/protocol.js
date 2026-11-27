import { object, problem } from '../config.js';
import { version } from '../update.js';
import { toolMap } from './tools.js';
import { summarize, textLimit } from './summary.js';

export const versions = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export function errorInfo(error) {
  return { code: typeof error?.code === 'string' ? error.code : 'E_INTERNAL', message: error?.message ?? 'Internal error.',
    remedy: error?.remedy, details: error?.details };
}

export function createProtocol(service) {
  const tools = toolMap(service);
  const definitions = [...tools.values()].map(({ call, ...tool }) => tool);
  const levels = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];
  const setLevel = new Map();
  return async function protocol(message, notify = () => {}, session = 'stdio') {
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
      || (Object.hasOwn(message, 'id') && !['string', 'number'].includes(typeof message.id))) {
      return rpcError(null, -32600, 'Invalid Request');
    }
    const { id, method, params } = message;
    if (id === undefined) return;
    if (params !== undefined && !object(params)) return rpcError(id, -32602, 'Invalid params');
    const success = result => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') {
      if (typeof params?.protocolVersion !== 'string') return rpcError(id, -32602, 'protocolVersion is required');
      await service.noteClient?.(params.clientInfo);
      return success({ protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0],
        capabilities: { tools: {}, logging: {} }, serverInfo: { name: 'agents', version },
        instructions: service.instructions?.() });
    }
    if (method === 'ping') return success({});
    if (method === 'logging/setLevel') {
      if (!levels.includes(params?.level)) return rpcError(id, -32602, 'Invalid log level');
      setLevel.set(session, levels.indexOf(params.level));
      return success({});
    }
    if (method === 'tools/list') return success({ tools: definitions });
    if (method !== 'tools/call') return rpcError(id, -32601, 'Method not found');
    if (typeof params?.name !== 'string' || (params.arguments !== undefined && !object(params.arguments))) {
      return rpcError(id, -32602, 'Expected a tool name and arguments object');
    }
    let data;
    let isError = false;
    const progressToken = params._meta?.progressToken;
    const progress = typeof progressToken === 'string' || typeof progressToken === 'number';
    const watching = params.name === 'agents_status' && Object.hasOwn(params.arguments ?? {}, 'after');
    const sendProgress = (count, text, total) => notify({ jsonrpc: '2.0', method: 'notifications/progress',
      params: { progressToken, progress: count, total, message: text } });
    const started = Date.now();
    let toolName = params.name;
    let failed = false;
    let task = params.arguments?.task;
    if (progress) sendProgress(1, watching ? '读取协作消息' : 'Processing request', watching ? undefined : 2);
    try {
      const tool = tools.get(params.name);
      if (!tool) throw problem('E_TOOL', 'Unknown tool: ' + params.name, 'Call tools/list for the supported names.');
      // One switch for the whole server: while it is off nothing starts an agent, and the
      // answer says so in words the model can repeat to the user.
      if (!service.mcpEnabled?.()) {
        throw problem('E_DISABLED', 'Agents-MCP 已停用：本次调用没有执行。',
          '在面板 header 点「启用 Agents-MCP」后重试；停用期间所有 agents_* 工具都会这样返回。');
      }
      data = await tool.call(params.arguments ?? {});
    } catch (error) {
      isError = true;
      failed = true;
      data = errorInfo(error);
    }
    await service.noteCall?.({ tool: toolName, ok: !failed, ms: Date.now() - started, task });
    // Gate replies already redact their free text and carry an opaque task ID.
    const structuredContent = Object.hasOwn(data, 'taskId') ? data : service.redact(data);
    if (progress) {
      const timeline = watching && !isError ? structuredContent.timeline ?? [] : [];
      const total = timeline.length + 2;
      timeline.forEach((event, index) => {
        const detail = event.detail ? ' · ' + event.detail.replace(/\s+/g, ' ').slice(0, 160) : '';
        sendProgress(index + 2, event.message + detail, total);
      });
      sendProgress(total, isError ? 'Request failed' : watching ? '协作消息读取完成' : 'Request handled', total);
    }
    // Spoken, not inferred: the user asked to be told every time whether the server is on.
    if (object(structuredContent) && !Object.hasOwn(structuredContent, 'tellUser')) {
      structuredContent.tellUser = service.mcpEnabled?.() === false ? 'Agents-MCP 已停用' : 'Agents-MCP 已启用';
    }
    const level = isError ? 'error' : 'info';
    if (levels.indexOf(level) >= (setLevel.get(session) ?? Infinity)) {
      notify({ jsonrpc: '2.0', method: 'notifications/message', params: { level, logger: 'agents',
        data: service.redact({ tool: params.name, status: structuredContent.status, runId: structuredContent.runId,
          code: isError ? structuredContent.code : undefined }) } });
    }
    // Both copies used to carry the whole payload; a big answer now says what it is and
    // leaves the detail in structuredContent, which halves the tokens such a call costs.
    const json = JSON.stringify(structuredContent);
    const body = structuredContent.timelineCursor !== undefined || Buffer.byteLength(json, 'utf8') > textLimit
      ? summarize(params.name, structuredContent) : json;
    return success({ structuredContent, isError, content: [{ type: 'text', text: body }] });
  };
}
