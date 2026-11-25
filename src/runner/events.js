export function normalize(adapter, line) {
  try {
    return adapter.parseStream(line) ?? { type: 'raw', text: line };
  } catch {
    return { type: 'raw', text: line };
  }
}

export function jsonEvent(line) {
  const event = JSON.parse(line);
  const { type, item, message } = event;
  const sessionId = [event.thread_id, event.session_id, event.conversation_id, event.sessionId, event.conversationId, event.threadId]
    .find(id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id));
  if (type === 'result') {
    return {
      type: event.is_error || (event.status && !['SUCCESS', 'success'].includes(event.status)) ? 'error' : 'result',
      text: event.result ?? event.response ?? event.text ?? event.error, sessionId,
    };
  }
  if (type === 'assistant' || type === 'message_end' || type === 'message' || type === 'agent_end') {
    const messages = event.messages ?? [message ?? event];
    const finalMessage = messages.filter(entry => entry?.role === 'assistant' || type === 'assistant').at(-1);
    const text = typeof finalMessage?.content === 'string' ? finalMessage.content
      : finalMessage?.content?.filter?.(part => part.type === 'text').map(part => part.text).join('\n');
    if (text) return { type: type === 'agent_end' ? 'result' : 'assistant', text, sessionId };
  }
  if (type === 'item.completed' && item?.type === 'agent_message') return { type: 'assistant', text: item.text };
  if (type === 'item.completed' && item?.type === 'reasoning') return { type: 'reasoning', text: item.text };
  if (type === 'error' || type === 'turn.failed') {
    return { type: 'error', text: event.message ?? event.error?.message ?? event.error };
  }
  if (sessionId) return { type: 'raw', data: { type }, sessionId };
  if (item || /tool/.test(type)) return { type: 'tool', data: item ?? event };
  return { type: 'raw', data: event };
}
