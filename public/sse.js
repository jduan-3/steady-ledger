// Shared UTF-8 SSE reader for provider responses and the browser chat.
export async function readEventStream(body, onEvent, { maxBytes = 2e6 } = {}) {
  if (!body) throw new Error('没有收到流式响应');
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', event = 'message', data = [], size = 0;
  const line = value => {
    if (value === '') {
      const next = { event, data: data.join('\n') }; event = 'message';
      const hasData = data.length > 0; data = [];
      return hasData ? onEvent(next) : undefined;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':'), name = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (name === 'event') event = content;
    if (name === 'data') data.push(content);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw Object.assign(new Error('流式响应过大'), { code: 'SSE_SIZE' });
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const value = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (line(value) === false) return;
      }
    }
    // An unterminated frame is incomplete, so it must not be dispatched.
  } finally { await reader.cancel().catch(() => {}); }
}
