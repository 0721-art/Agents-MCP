const reasoningTypes = new Set(['reasoning', 'thinking', 'reasoning_delta', 'thinking_delta', 'reasoning_summary']);
const usageKeys = {
  inputTokens: ['input_tokens', 'inputTokens'],
  outputTokens: ['output_tokens', 'outputTokens'],
  reasoningTokens: ['reasoning_output_tokens', 'reasoning_tokens', 'thinking_tokens', 'reasoningTokens', 'thinkingTokens'],
};

// Reasoning arrives as a whole paragraph on some CLIs and as summary parts on others.
function reasoningText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(part => reasoningText(part?.text ?? part?.thinking ?? part?.summary ?? part?.content))
      .filter(Boolean).join('\n');
  }
  if (value && typeof value === 'object') return reasoningText(value.text ?? value.thinking ?? value.summary ?? value.content);
  return '';
}

// Token counts are the only trace some CLIs leave of their thinking, so they are worth keeping.
function usageOf(event) {
  const usage = event.usage ?? event.result?.usage ?? event.turn?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const counts = {};
  for (const [key, names] of Object.entries(usageKeys)) {
    const value = names.map(name => usage[name]).find(candidate => Number.isFinite(candidate));
    if (value !== undefined) counts[key] = value;
  }
  return Object.keys(counts).length ? counts : undefined;
}

function parsed(event) {
  const { type, item, message } = event;
  const sessionId = [event.thread_id, event.session_id, event.conversation_id, event.sessionId, event.conversationId, event.threadId]
    .find(id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id));
  if (item?.type === 'reasoning') {
    return { type: 'reasoning', text: reasoningText(item.text ?? item.summary ?? item.content), sessionId };
  }
  if (reasoningTypes.has(type)) {
    return { type: 'reasoning', text: reasoningText(event.text ?? event.delta ?? event.content
      ?? event.reasoning_content ?? event.thinking), sessionId };
  }
  if (typeof event.reasoning_content === 'string' && event.reasoning_content) {
    return { type: 'reasoning', text: event.reasoning_content, sessionId };
  }
  if (type === 'result') {
    return {
      type: event.is_error || (event.status && !['SUCCESS', 'success'].includes(event.status)) ? 'error' : 'result',
      text: event.result ?? event.response ?? event.text ?? event.error, sessionId,
    };
  }
  if (type === 'assistant' || type === 'message_end' || type === 'message' || type === 'agent_end') {
    const messages = event.messages ?? [message ?? event];
    const finalMessage = messages.filter(entry => entry?.role === 'assistant' || type === 'assistant').at(-1);
    const parts = Array.isArray(finalMessage?.content) ? finalMessage.content : [];
    const text = typeof finalMessage?.content === 'string' ? finalMessage.content
      : parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
    if (text) return { type: type === 'agent_end' ? 'result' : 'assistant', text, sessionId };
    // Claude streams a thinking block as its own assistant message before the answer.
    const thinking = parts.filter(part => part.type === 'thinking' || part.type === 'reasoning')
      .map(part => part.thinking ?? part.text ?? part.content).filter(Boolean).join('\n');
    if (thinking) return { type: 'reasoning', text: thinking, sessionId };
  }
  if (type === 'item.completed' && item?.type === 'agent_message') return { type: 'assistant', text: item.text };
  if (type === 'error' || type === 'turn.failed') {
    return { type: 'error', text: event.message ?? event.error?.message ?? event.error };
  }
  if (sessionId) return { type: 'raw', data: { type }, sessionId };
  if (item || /tool/.test(type)) return { type: 'tool', data: item ?? event };
  return { type: 'raw', data: event };
}

export function normalize(adapter, line) {
  try {
    return adapter.parseStream(line) ?? { type: 'raw', text: line };
  } catch {
    return { type: 'raw', text: line };
  }
}

export function jsonEvent(line) {
  const event = JSON.parse(line);
  const parsedEvent = parsed(event);
  const usage = usageOf(event);
  return usage ? { ...parsedEvent, usage } : parsedEvent;
}
