function encodeMessages(messages) {
  return messages.map(message => {
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.callId, content: JSON.stringify(message.result) };
    if (message.role === 'assistant') return { role: 'assistant', content: message.text || null,
      ...(message.calls?.length ? { tool_calls: message.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) };
    return { role: message.role === 'system' ? 'system' : 'user', content: message.text };
  });
}

function decodeCall(call) {
  if (typeof call.id !== 'string' || !call.id || typeof call.function?.name !== 'string' || !call.function.name) throw new Error('Incomplete tool identity');
  return { id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments) };
}

function incompleteTurn(text, finishReason, usage) {
  if (finishReason === 'stop' || finishReason === 'tool_calls') return;
  // A provider's truncation/filter marker is an execution fact. Keep received
  // text, but do not dispatch unfinished function proposals or claim completion.
  return { text, calls: [], usage, complete: false, finishReason };
}

// Nothing calls a paid provider until the caller explicitly selects this gateway.
export function createChatGateway({ baseUrl, model, apiKey, fetchImpl = fetch, stream = true }) {
  if (!baseUrl || !model) throw new Error('Set HARNESS_BASE_URL and HARNESS_MODEL');
  const endpoint = new URL('chat/completions', baseUrl.replace(/\/?$/, '/'));
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Invalid provider URL');
  return {
    async next({ messages, tools, signal }) {
      const response = await fetchImpl(endpoint, { method: 'POST', signal,
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, messages: encodeMessages(messages), stream,
          tools: tools.map(({ name, description, inputSchema }) => ({ type: 'function', function: { name, description, parameters: inputSchema } })) }) });
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
      if (!stream) {
        const data = await response.json(), choice = data.choices?.[0];
        if (!choice?.finish_reason) throw new Error('Provider response did not finish');
        const incomplete = incompleteTurn(choice.message.content ?? '', choice.finish_reason, data.usage);
        if (incomplete) return incomplete;
        return { text: choice.message.content ?? '', calls: (choice.message.tool_calls ?? []).map(decodeCall), usage: data.usage };
      }
      const pending = new Map(); let text = '', finished = false, ended = false, finishReason, usage;
      let buffer = '';
      function consume(frame) {
        const payload = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!payload) return;
        if (payload === '[DONE]') { ended = true; return; }
        const item = JSON.parse(payload);
        if (item.usage) usage = item.usage;
        for (const choice of item.choices ?? []) {
          if (choice.index !== 0) continue;
          text += choice.delta?.content ?? '';
          for (const part of choice.delta?.tool_calls ?? []) {
            const call = pending.get(part.index) ?? { id: '', name: '', arguments: '' };
            if (part.id) call.id = part.id;
            call.name += part.function?.name ?? '';
            call.arguments += part.function?.arguments ?? '';
            pending.set(part.index, call);
          }
          if (choice.finish_reason) { finished = true; finishReason = choice.finish_reason; }
        }
      }
      const decoder = new TextDecoder();
      for await (const bytes of response.body) {
        buffer += decoder.decode(bytes, { stream: true });
        // Normalize CRLF only when splitting, so a boundary split across chunks survives.
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          consume(buffer.slice(0, match.index).replace(/\r\n/g, '\n'));
          buffer = buffer.slice(match.index + match[0].length);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer.replace(/\r\n/g, '\n'));
      if (!finished || !ended) throw new Error('Provider stream ended before its completion markers');
      const incomplete = incompleteTurn(text, finishReason, usage);
      if (incomplete) return incomplete;
      const calls = [...pending.entries()].sort(([a], [b]) => a - b).map(([, call]) => {
        return decodeCall({ id: call.id, function: { name: call.name, arguments: call.arguments } });
      });
      return { text, calls, usage };
    },
  };
}
