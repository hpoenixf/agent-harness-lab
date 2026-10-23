import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createChatGateway } from '../src/gateway.mjs';

const credentials = { baseUrl: 'https://provider.example/v1', model: 'teaching-model', apiKey: 'synthetic-key' };
const nextInput = { messages: [{ role: 'user', text: 'Compare the supplied manuals.' }], tools: [] };
const completion = (message, finish_reason = 'stop') => ({ choices: [{ index: 0, message, finish_reason }], usage: { prompt_tokens: 12, completion_tokens: 4 } });
const event = item => `data: ${typeof item === 'string' ? item : JSON.stringify(item)}\r\n\r\n`;
function streamResponse(body) {
  const bytes = new TextEncoder().encode(body);
  return new Response(new ReadableStream({
    start(controller) {
      // Three-byte chunks split both CRLF boundaries and Chinese UTF-8 characters.
      for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

test('non-stream request maps schemas and preserves assistant/tool message identities through real HTTP', async t => {
  let request;
  let requestPath;
  let authorization;
  const server = createServer(async (incoming, outgoing) => {
    requestPath = incoming.url;
    authorization = incoming.headers.authorization;
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    outgoing.setHeader('content-type', 'application/json');
    outgoing.end(JSON.stringify(completion({ content: 'Compared.', tool_calls: [{ id: 'next-call', type: 'function', function: { name: 'read_page', arguments: '{"documentId":"B","page":2}' } }] }, 'tool_calls')));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const schema = { type: 'object', properties: { documentId: { type: 'string' } }, required: ['documentId'] };
  const gateway = createChatGateway({ ...credentials, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, stream: false });
  const receipt = { id: 'prior-call', status: 'completed', output: { text: 'A says 手动保存.' } };
  const result = await gateway.next({
    messages: [
      { role: 'system', text: 'Use supplied evidence.' },
      { role: 'user', text: 'Compare saving.' },
      { role: 'assistant', text: '', calls: [{ id: 'prior-call', name: 'read_page', args: { documentId: 'A', page: 1 } }] },
      { role: 'tool', callId: 'prior-call', result: receipt },
    ],
    tools: [{ name: 'read_page', description: 'Read a supplied page', inputSchema: schema }],
  });
  assert.equal(requestPath, '/v1/chat/completions');
  assert.equal(authorization, 'Bearer synthetic-key');
  assert.equal(request.model, credentials.model);
  assert.equal(request.stream, false);
  assert.deepEqual(request.tools, [{ type: 'function', function: { name: 'read_page', description: 'Read a supplied page', parameters: schema } }]);
  assert.deepEqual(request.messages[2], { role: 'assistant', content: null, tool_calls: [{ id: 'prior-call', type: 'function', function: { name: 'read_page', arguments: '{"documentId":"A","page":1}' } }] });
  assert.deepEqual(JSON.parse(request.messages[3].content), receipt);
  assert.equal(request.messages[3].tool_call_id, 'prior-call');
  assert.deepEqual(result, { text: 'Compared.', calls: [{ id: 'next-call', name: 'read_page', args: { documentId: 'B', page: 2 } }], usage: { prompt_tokens: 12, completion_tokens: 4 } });
});

test('SSE reassembles interleaved tool calls, UTF-8 text, CRLF frames and final usage', async () => {
  const frames = [
    ': keepalive\r\n\r\n',
    event({ choices: [{ index: 0, delta: { content: '比较', tool_calls: [{ index: 1, id: 'call-B', function: { name: 'read_', arguments: '{"documentId":' } }] } }] }),
    event({ choices: [{ index: 1, delta: { content: 'ignored alternate' } }, { index: 0, delta: { tool_calls: [{ index: 0, id: 'call-A', function: { name: 'search', arguments: '{"query":"' } }] } }] }),
    event({ choices: [{ index: 0, delta: { content: '保存', tool_calls: [{ index: 1, function: { name: 'page', arguments: '"B","page":2}' } }, { index: 0, function: { arguments: '自动保存"}' } }] } }] }),
    event({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    event({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 9 } }),
    event('[DONE]'),
  ];
  const gateway = createChatGateway({ ...credentials, fetchImpl: async () => streamResponse(frames.join('')) });
  assert.deepEqual(await gateway.next(nextInput), {
    text: '比较保存',
    calls: [{ id: 'call-A', name: 'search', args: { query: '自动保存' } }, { id: 'call-B', name: 'read_page', args: { documentId: 'B', page: 2 } }],
    usage: { prompt_tokens: 20, completion_tokens: 9 },
  });
});

test('SSE accepts multi-line data and a final event without an empty-line terminator', async () => {
  const body = 'event: message\ndata: {"choices":[\ndata: {"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]';
  const gateway = createChatGateway({ ...credentials, fetchImpl: async () => streamResponse(body) });
  assert.equal((await gateway.next(nextInput)).text, 'ok');
});

test('SSE requires both the choice completion marker and terminal DONE marker', async () => {
  for (const body of [event({ choices: [{ index: 0, delta: { content: 'partial' } }] }) + event('[DONE]'), event({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: 'stop' }] })]) {
    const gateway = createChatGateway({ ...credentials, fetchImpl: async () => streamResponse(body) });
    await assert.rejects(() => gateway.next(nextInput), /completion markers/);
  }
});

test('truncated or filtered responses retain received text and mark the turn incomplete in either mode', async () => {
  for (const reason of ['length', 'content_filter']) {
    for (const stream of [false, true]) {
      const tool = { id: 'unfinished', function: { name: 'read_page', arguments: '{"page":' } };
      const fetchImpl = async () => stream ? streamResponse(event({ choices: [{ index: 0, delta: { content: 'partial', tool_calls: [{ index: 0, ...tool }] }, finish_reason: reason }] }) + event('[DONE]')) : Response.json(completion({ content: 'partial', tool_calls: [tool] }, reason));
      const gateway = createChatGateway({ ...credentials, stream, fetchImpl });
      const result = await gateway.next(nextInput);
      assert.equal(result.text, 'partial');
      assert.equal(result.complete, false);
      assert.equal(result.finishReason, reason);
      assert.deepEqual(result.calls, []);
    }
  }
});

test('non-stream missing finish marker and incomplete tool identities fail explicitly', async () => {
  for (const data of [completion({ content: 'partial' }, null), completion({ content: null, tool_calls: [{ function: { name: 'read_page', arguments: '{}' } }] }, 'tool_calls')]) {
    const gateway = createChatGateway({ ...credentials, stream: false, fetchImpl: async () => Response.json(data) });
    await assert.rejects(() => gateway.next(nextInput), /did not finish|Incomplete tool identity/);
  }
});

test('malformed tool argument JSON fails in both modes rather than inventing empty arguments', async () => {
  for (const stream of [false, true]) {
    const call = { id: 'broken', function: { name: 'read_page', arguments: '{"page":' } };
    const fetchImpl = async () => stream ? streamResponse(event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: 'tool_calls' }] }) + event('[DONE]')) : Response.json(completion({ content: null, tool_calls: [call] }, 'tool_calls'));
    await assert.rejects(() => createChatGateway({ ...credentials, stream, fetchImpl }).next(nextInput), SyntaxError);
  }
});

test('HTTP failures report status and omit untrusted response-body content', async () => {
  const gateway = createChatGateway({ ...credentials, fetchImpl: async () => new Response('secret provider diagnostics', { status: 429 }) });
  await assert.rejects(() => gateway.next(nextInput), error => error.message === 'Provider returned HTTP 429');
});

test('caller cancellation signal reaches fetch and cancellation remains a failed request', async () => {
  const controller = new AbortController();
  controller.abort();
  const gateway = createChatGateway({ ...credentials, fetchImpl: async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    options.signal.throwIfAborted();
  } });
  await assert.rejects(() => gateway.next({ ...nextInput, signal: controller.signal }), error => error.name === 'AbortError');
});
