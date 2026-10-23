import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkbench, runWorkbench } from '../src/workbench.mjs';

test('complete offline loop persists paired messages, original sources, calculation lineage and downloadable files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runWorkbench({ directory });
  assert.equal(result.status, 'completed');
  const work = await openWorkbench(directory);
  t.after(() => work.close());
  const report = await work.publications.get('comparison');
  assert.equal(report.status, 'committed');
  assert.equal(report.revision, 1);
  assert.match(report.body, /Markdown.*PDF/s);
  assert.equal(report.citations.length, 4);
  for (const citation of report.citations) {
    const original = await work.sources.get(citation.source.id);
    assert.equal(original.version, citation.source.version);
    assert.ok([2, 4].includes(original.page));
  }
  assert.equal(report.attachments.length, 4);
  for (const attachment of report.attachments) assert.ok((await work.artifacts.get(attachment.artifact.id)).bytes.length);
  const messages = work.messages();
  for (const message of messages.filter(m => m.role === 'assistant')) {
    for (const call of message.calls ?? []) assert.equal(messages.filter(m => m.role === 'tool' && m.callId === call.id).length, 1);
  }
  const events = work.store.events();
  const calc = events.find(e => e.type === 'tool-result' && e.name === 'calculate_limits').result;
  assert.equal(calc.ratio, 5);
  assert.equal(calc.increase, 4000);
  assert.equal(calc.codeHash.length, 64);
  assert.equal(calc.inputSourceIds.length, 2);
  assert.equal((await work.memory.recall()).length, 1);
  assert.equal((await work.compactions.list()).length, 1);
  const again = await runWorkbench({ directory });
  assert.equal(again.status, 'completed');
  assert.equal(again.reused, true);
  assert.equal((await work.publications.get('comparison')).revision, 1);
});

test('a tiny shared budget stops before an undispatched call and preserves completed observations', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runWorkbench({ directory, initial: { budget: { modelRequests: 3, toolCalls: 2 } } });
  assert.equal(result.status, 'paused');
  const work = await openWorkbench(directory);
  t.after(() => work.close());
  assert.ok(work.store.events().some(e => e.type === 'tool-result'));
  assert.equal(await work.publications.get('comparison'), undefined);
});

test('incomplete provider text remains a draft rather than a completed Run', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-draft-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runWorkbench({ directory, gateway: { next: async () => ({ text: '已经收到的正文', calls: [], complete: false, finishReason: 'length' }) } });
  assert.equal(result.status, 'paused');
  assert.equal(result.text, '已经收到的正文');
  const work = await openWorkbench(directory);
  t.after(() => work.close());
  assert.equal(work.store.events().find(e => e.type === 'draft').text, result.text);
  assert.ok(!work.store.events().some(e => e.type === 'completed'));
});

test('durable user cancellation aborts the pending provider and prevents later tool effects', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let requested;
  const entered = new Promise(resolve => { requested = resolve; });
  const running = runWorkbench({ directory, gateway: { next: async ({ signal }) => {
    requested();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true }));
  } } });
  await entered;
  const control = await openWorkbench(directory);
  await control.store.cancel();
  await control.close();
  const result = await running;
  assert.equal(result.status, 'paused');
  const work = await openWorkbench(directory);
  t.after(() => work.close());
  assert.equal((await work.artifacts.list()).length, 0);
  assert.ok(!work.store.events().some(e => e.type === 'completed'));
});

test('cold recovery reuses a persisted final turn even with no remaining model budget', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-final-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const work = await openWorkbench(directory, { gatewayMode: 'fixture', budget: { modelRequests: 1, toolCalls: 0 } });
  await work.store.claim();
  await work.store.record({ type: 'model-request', turnId: 'turn-1' });
  await work.store.record({ type: 'assistant', scope: 'root', turnId: 'turn-1', text: '已完成的终稿', calls: [] });
  await work.close();
  const result = await runWorkbench({ directory });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '已完成的终稿');
});

test('a child budget stop keeps successful pages and permits a final partial answer', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-child-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let requests = 0;
  const gateway = { next: async () => { requests++; return requests === 1 ? { text: '', calls: [{ id: 'delegate', name: 'delegate_reads', args: { documentIds: ['manual-a-v1', 'manual-b-v2'] } }] } : { text: '只读取了一页，比较尚未完成。', calls: [] }; } };
  const result = await runWorkbench({ directory, initial: { budget: { modelRequests: 10, toolCalls: 2 } }, gateway });
  assert.equal(result.status, 'completed');
  assert.match(result.text, /尚未完成/);
  assert.equal(requests, 2);
  const work = await openWorkbench(directory);
  t.after(() => work.close());
  const childResult = work.store.events().find(e => e.type === 'tool-result' && e.name === 'delegate_reads').result;
  assert.equal(childResult.status, 'ok');
  assert.equal(childResult.coverage, 'partial');
  assert.equal(childResult.children.flatMap(c => c.sourceIds).length, 1);
  assert.equal((await work.sources.list()).length, 1);
});

test('resume cannot silently switch a live Run to the fixture gateway', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-mode-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const work = await openWorkbench(directory, { gatewayMode: 'chat-completions' });
  await work.close();
  await assert.rejects(runWorkbench({ directory }), /original gateway mode/);
});
