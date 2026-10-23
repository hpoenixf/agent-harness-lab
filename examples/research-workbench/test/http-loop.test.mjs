import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatGateway } from '../src/gateway.mjs';
import { createFixtureGateway, openWorkbench, runWorkbench } from '../src/workbench.mjs';

function decodeMessages(messages) {
  return messages.map(message => {
    if (message.role === 'tool') return { role: 'tool', callId: message.tool_call_id, result: JSON.parse(message.content) };
    if (message.role === 'assistant') return {
      role: 'assistant', text: message.content ?? '',
      calls: (message.tool_calls ?? []).map(call => ({ id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments) })),
    };
    return { role: message.role, text: message.content };
  });
}

test('ordinary Chat Completions HTTP JSON completes the workbench and saves its report and files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-http-loop-'));
  const fixture = createFixtureGateway();
  const requests = [];
  const providerErrors = [];
  let work;
  // This is a protocol test server on loopback, not a remote or paid model.
  const server = createServer(async (incoming, outgoing) => {
    try {
      assert.equal(incoming.method, 'POST');
      assert.equal(incoming.url, '/v1/chat/completions');
      assert.equal(incoming.headers.authorization, 'Bearer local-test-key');
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(request);
      assert.equal(request.model, 'local-scripted-model');
      assert.equal(request.stream, false);
      assert.ok(request.tools.length > 0);
      for (const tool of request.tools) {
        assert.equal(tool.type, 'function');
        assert.equal(typeof tool.function.name, 'string');
        assert.equal(typeof tool.function.description, 'string');
        assert.equal(tool.function.parameters.type, 'object');
        assert.equal(Object.hasOwn(tool.function, 'inputSchema'), false);
      }
      const readPage = request.tools.find(tool => tool.function.name === 'read_page').function;
      assert.deepEqual(readPage.parameters.required, ['documentId', 'page']);
      assert.equal(readPage.parameters.properties.page.type, 'integer');
      assert.equal(readPage.parameters.additionalProperties, false);
      const next = await fixture.next({ messages: decodeMessages(request.messages) });
      const calls = next.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }));
      outgoing.setHeader('content-type', 'application/json');
      outgoing.end(JSON.stringify({
        id: `local-response-${requests.length}`, object: 'chat.completion', model: request.model,
        choices: [{ index: 0, message: { role: 'assistant', content: next.text || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }));
    } catch (error) {
      providerErrors.push(error);
      outgoing.writeHead(500, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'Local protocol assertion failed' }));
    }
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const gateway = createChatGateway({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-scripted-model', apiKey: 'local-test-key', stream: false });
    // No summarize method: every model turn uses only the ordinary HTTP adapter.
    let result;
    try { result = await runWorkbench({ directory, gateway }); }
    catch (error) { if (providerErrors.length) throw new AggregateError(providerErrors, 'Local provider rejected the wire request'); throw error; }
    assert.deepEqual(providerErrors, []);
    assert.equal(result.status, 'completed');
    assert.match(result.text, /报告已保存/);
    assert.ok(requests.length > 1);
    assert.equal(result.budget.modelRequests.used, requests.length);
    work = await openWorkbench(directory);
    assert.equal(work.store.run.gatewayMode, 'chat-completions');
    assert.equal((await work.compactions.list()).length, 0);
    const report = await work.publications.get('comparison');
    assert.equal(report.status, 'committed');
    assert.equal(report.revision, 1);
    assert.match(report.body, /A 版仅支持 Markdown.*B 版支持 Markdown 和 PDF/s);
    assert.match(report.body, /1000.*5000.*4000.*5/s);
    assert.equal(report.citations.length, 4);
    assert.ok(report.citations.every(citation => citation.status === 'available'));
    assert.equal(report.attachments.length, 4);
    for (const attachment of report.attachments) {
      assert.equal(attachment.status, 'available');
      assert.ok((await work.artifacts.get(attachment.artifact.id)).bytes.length > 0);
    }
    // Final wire history must pair the same call IDs and JSON arguments/results
    // that the Host actually recorded; children do not invent root messages.
    const finalHistory = decodeMessages(requests.at(-1).messages);
    const events = work.store.events();
    for (const message of finalHistory.filter(message => message.role === 'assistant')) {
      for (const call of message.calls) {
        const results = finalHistory.filter(message => message.role === 'tool' && message.callId === call.id);
        assert.equal(results.length, 1);
        const recorded = events.find(event => event.type === 'tool-start' && event.callId === call.id);
        assert.equal(recorded.name, call.name);
        assert.deepEqual(recorded.args, call.args);
        assert.deepEqual(results[0].result, events.find(event => event.type === 'tool-result' && event.callId === call.id).result);
      }
    }
    assert.ok(events.some(event => event.type === 'completed'));
  } finally {
    await work?.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
