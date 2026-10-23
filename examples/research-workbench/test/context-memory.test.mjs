import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retrieveDocuments, buildContext, summarizeSettledTurns, createCompactionStore } from '../src/context.mjs';
import { createMemoryStore } from '../src/memory.mjs';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'context-memory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const documents = {
  A: { version: '1.0', pages: ['安装说明', '离线导出支持 PDF。'] },
  B: { version: '2.0', pages: ['安装说明', 'PDF 导出需要联网。离线可导出 Markdown。'] },
};
function transcript() {
  return [
    { role: 'user', text: '只比较 A/B 免费版；不要联网。' },
    { role: 'assistant', text: '', turnId: 'turn-1', calls: [
      { id: 'read-a', name: 'read_page', args: { documentId: 'A', page: 2 } },
      { id: 'read-b', name: 'read_page', args: { documentId: 'B', page: 2 } },
    ] },
    { role: 'tool', callId: 'read-a', result: { status: 'ok', sourceId: 'A-v1-p2', text: 'A 原页。'.repeat(250) } },
    { role: 'tool', callId: 'read-b', result: { status: 'ok', sourceId: 'B-v2-p2', text: 'B 原页。'.repeat(250) } },
    { role: 'user', text: '更正：保留原页码。' },
    { role: 'assistant', text: '', turnId: 'turn-2', calls: [{ id: 'recent', name: 'read_page', args: { documentId: 'B', page: 1 } }] },
    { role: 'tool', callId: 'recent', result: { status: 'ok', sourceId: 'B-v2-p1', text: '最新工作材料。'.repeat(40) } },
  ];
}
function sourceStore(messages) {
  const windows = new Map(messages.filter(m => m.role === 'tool').map(m => [m.result.sourceId, { sourceId: m.result.sourceId, text: m.result.text }]));
  return { async get(id) { return structuredClone(windows.get(id)); } };
}

test('retrieval keeps version/page identity and respects the selected document set', async () => {
  const hits = await retrieveDocuments({ documents, query: '离线 导出', documentIds: ['A', 'B'] });
  assert.deepEqual(hits.map(h => [h.documentId, h.version, h.page]).sort(), [['A', '1.0', 2], ['B', '2.0', 2]]);
  assert(hits.every(h => h.score > 0 && h.text === documents[h.documentId].pages[h.page - 1]));
  const restricted = await retrieveDocuments({ documents, query: '离线', documentIds: ['A'] });
  assert(restricted.every(h => h.documentId === 'A'));
});

test('context externalizes old exact windows while preserving pairs, users and the recent group', async () => {
  const messages = transcript();
  const sources = sourceStore(messages);
  const context = await buildContext({ messages, sources, memoryRecords: [{ familyId: 'F1', version: 1, summary: '先给比较表。' }], maxChars: 1700 });
  assert.equal(context.fits, true);
  assert.deepEqual(context.externalizedSourceIds, ['A-v1-p2', 'B-v2-p2']);
  assert.deepEqual(context.messages.filter(m => m.role === 'user'), messages.filter(m => m.role === 'user'));
  assert.deepEqual(context.messages.filter(m => m.role === 'assistant'), messages.filter(m => m.role === 'assistant'));
  assert.deepEqual(context.messages.filter(m => m.role === 'tool').map(m => m.callId), ['read-a', 'read-b', 'recent']);
  assert.equal(context.messages.at(-1).result.text, messages.at(-1).result.text);
  for (const message of context.messages.filter(m => m.result?.representation === 'reference-only')) {
    assert.equal(message.result.text, undefined);
    assert.equal((await sources.get(message.result.sourceId)).text, messages.find(m => m.callId === message.callId).result.text);
  }
  assert(messages[2].result.text, 'the original transcript remains intact');
});

test('insufficient capacity or mismatching stored bytes never deletes task facts', async () => {
  const messages = transcript();
  const context = await buildContext({ messages, sources: { async get() { return { text: 'different material' }; } }, maxChars: 50 });
  assert.equal(context.fits, false);
  assert.deepEqual(context.messages, messages);
  assert.deepEqual(context.externalizedSourceIds, []);
});

test('the most recent multi-call group remains complete even when the context cannot fit', async () => {
  const messages = transcript();
  messages[5].calls.push({ id: 'recent-2', name: 'read_page', args: { documentId: 'A', page: 1 } });
  messages.push({ role: 'tool', callId: 'recent-2', result: { status: 'ok', sourceId: 'A-v1-p1', text: '另一份最新材料。'.repeat(40) } });
  const context = await buildContext({ messages, sources: sourceStore(messages), maxChars: 50 });
  assert.equal(context.fits, false);
  assert.deepEqual(context.messages.slice(5), messages.slice(5));
  assert.deepEqual(context.externalizedSourceIds, ['A-v1-p2', 'B-v2-p2']);
});

test('an unsettled group cannot reach the summarizer or produce a segment', async () => {
  const messages = transcript().slice(0, 4);
  messages[3].result.status = 'unknown';
  let called = false;
  const segment = await summarizeSettledTurns({ messages, id: 'segment-1', basis: 'basis-1', summarize() { called = true; return 'incorrect success'; } });
  assert.equal(segment, null);
  assert.equal(called, false);
  const missing = await summarizeSettledTurns({ messages: messages.slice(0, 3), id: 'segment-1', basis: 'basis-1', summarize() { called = true; } });
  assert.equal(missing, null);
  assert.equal(called, false);
});

test('a summary retains its exact basis and survives a cold store opening', async t => {
  const messages = transcript().slice(0, 4);
  let received;
  const segment = await summarizeSettledTurns({ messages, id: 'segment-1', basis: 'basis-1', summarize(input) {
    received = input;
    return '已读取 A/B 原页；PDF 导出条件不同。';
  } });
  assert.deepEqual(segment.modelTurnIds, ['turn-1']);
  assert.equal(segment.sourceTurnHashes.length, 1);
  assert.match(segment.sourceTurnHashes[0], /^[a-f0-9]{64}$/);
  assert.deepEqual(segment.references.map(r => r.sourceId), ['A-v1-p2', 'B-v2-p2']);
  assert.equal(JSON.stringify(received).includes('不要联网'), false, 'user restrictions are never rewritten by the summarizer');
  const directory = await workspace(t);
  const store = await createCompactionStore(directory);
  assert.deepEqual(await store.commit(segment), segment);
  assert.deepEqual(await store.commit(structuredClone(segment)), segment);
  const cold = await createCompactionStore(directory);
  assert.deepEqual(await cold.get('segment-1'), segment);
  assert.deepEqual(await cold.list(), [segment]);
  assert.deepEqual(await cold.commit(Object.fromEntries(Object.entries(segment).reverse())), segment);
  await assert.rejects(cold.commit({ ...segment, summary: 'different' }), /different|conflict/i);
});

test('memory versions, operation replay and forgetting remain truthful across cold opens', async t => {
  const directory = await workspace(t);
  let memory = await createMemoryStore(directory);
  const saved = await memory.commit({ operationId: 'save-1', operation: 'save', summary: '比较手册时先列免费版限制。', sourceMessageId: 'user-1' });
  assert.equal(saved.status, 'saved');
  memory = await createMemoryStore(directory);
  const [target] = await memory.search('手册');
  assert.equal(target.version, 1);
  const update = { operationId: 'update-1', operation: 'save', targetRef: target.targetRef, summary: '比较手册时先给差异表，再列限制。', sourceMessageId: 'user-2' };
  const updated = await memory.commit(update);
  assert.equal(updated.familyId, saved.familyId);
  assert.equal(updated.version, 2);
  assert.deepEqual(await memory.commit(update), updated);
  await assert.rejects(memory.commit({ ...update, summary: 'another value' }), /different|conflict/i);
  await assert.rejects(memory.commit({ ...update, operationId: 'stale-update' }), /stale|version/i);
  const [current] = await memory.search('手册');
  const forget = { operationId: 'forget-1', operation: 'forget', targetRef: current.targetRef, sourceMessageId: 'user-3' };
  const forgotten = await memory.commit(forget);
  assert.equal(forgotten.status, 'forgotten');
  assert.deepEqual(await memory.recall('手册'), []);
  memory = await createMemoryStore(directory);
  assert.deepEqual(await memory.search('手册'), []);
  assert.deepEqual(await memory.commit(forget), forgotten);
  const persisted = JSON.parse(await readFile(join(directory, 'memory.json'), 'utf8'));
  assert.equal(persisted.operations.length, 3);
  assert.equal(persisted.records.length, 3);
});

test('issued memory targets survive a pending update or forget across cold opens without rebinding versions', async t => {
  const directory = await workspace(t);
  let memory = await createMemoryStore(directory);
  const first = await memory.commit({ operationId: 'save-alpha', operation: 'save', summary: 'Alpha preference', sourceMessageId: 'user-alpha' });
  const second = await memory.commit({ operationId: 'save-beta', operation: 'save', summary: 'Beta preference', sourceMessageId: 'user-beta' });
  // These refs stand for a recorded search receipt before the worker stops.
  const issued = await memory.search('preference');
  const alpha = issued.find(target => target.familyId === first.familyId);
  const beta = issued.find(target => target.familyId === second.familyId);
  const update = { operationId: 'pending-update', operation: 'save', targetRef: alpha.targetRef, summary: 'Alpha revised preference', sourceMessageId: 'user-update' };
  memory = await createMemoryStore(directory);
  const updated = await memory.commit(update);
  assert.equal(updated.familyId, first.familyId);
  assert.equal(updated.version, 2);
  memory = await createMemoryStore(directory);
  await assert.rejects(memory.commit({ ...update, operationId: 'stale-update' }), /stale|version/i);
  const forget = { operationId: 'pending-forget', operation: 'forget', targetRef: beta.targetRef, sourceMessageId: 'user-forget' };
  const forgotten = await memory.commit(forget);
  assert.equal(forgotten.familyId, second.familyId);
  assert.equal(forgotten.status, 'forgotten');
  memory = await createMemoryStore(directory);
  assert.deepEqual(await memory.commit(update), updated);
  assert.deepEqual(await memory.commit(forget), forgotten);
  assert.deepEqual((await memory.recall('preference')).map(record => record.familyId), [first.familyId]);
  await assert.rejects(memory.commit({ operationId: 'forged-target', operation: 'forget', targetRef: 'memory-target-unissued', sourceMessageId: 'user-forged' }), /unknown|issued/i);
});
