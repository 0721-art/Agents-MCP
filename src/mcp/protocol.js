import { object, problem } from '../config.js';
import { toolMap } from './tools.js';

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
      return success({ protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0],
        capabilities: { tools: {}, logging: {} }, serverInfo: { name: 'agents', version: '0.1.0' } });
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
    const sendProgress = (count, text) => notify({ jsonrpc: '2.0', method: 'notifications/progress',
      params: { progressToken, progress: count, total: 2, message: text } });
    if (progress) sendProgress(1, 'Processing request');
    try {
      const tool = tools.get(params.name);
      if (!tool) throw problem('E_TOOL', 'Unknown tool: ' + params.name, 'Call tools/list for the supported names.');
      data = await tool.call(params.arguments ?? {});
    } catch (error) {
      isError = true;
      data = errorInfo(error);
    }
    if (progress) sendProgress(2, isError ? 'Request failed' : 'Request handled');
    // Gate replies already redact their free text and carry an opaque task ID.
    const structuredContent = Object.hasOwn(data, 'taskId') ? data : service.redact(data);
    const level = isError ? 'error' : 'info';
    if (levels.indexOf(level) >= (setLevel.get(session) ?? Infinity)) {
      notify({ jsonrpc: '2.0', method: 'notifications/message', params: { level, logger: 'agents',
        data: service.redact({ tool: params.name, status: structuredContent.status, runId: structuredContent.runId,
          code: isError ? structuredContent.code : undefined }) } });
    }
    return success({ structuredContent, isError, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] });
  };
}
