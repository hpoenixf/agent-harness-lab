import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { manuals } from '../fixtures/manuals.mjs';
import { openRunStore, hash, canonical } from './storage.mjs';
import { createSourceStore } from './sources.mjs';
import { createArtifactStore } from './artifacts.mjs';
import { createPublicationStore } from './publication.mjs';
import { createMemoryStore } from './memory.mjs';
import { createCompactionStore, buildContext, retrieveDocuments, summarizeSettledTurns } from './context.mjs';
import { createToolRegistry, createExtensionHost } from './extensions.mjs';
import { createSkillCatalog } from './skills.mjs';
import { SharedBudget, runSubagents } from './subagents.mjs';
import { usageMetadata } from './observability.mjs';

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string', minLength: 1 };
const strings = { type: 'array', items: string };
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const calculate = (before, after) => ({ before, after, increase: after - before, ratio: after / before });
const calculationHash = hash(calculate.toString());
const operation = (runId, callId) => `op-${hash(`${runId}:${callId}`)}`;
class Paused extends Error {}

export async function openWorkbench(directory, initial = {}) {
  const store = await openRunStore(directory, initial);
  for (const name of ['memory', 'compactions']) await mkdir(join(directory, name), { recursive: true });
  const sources = await createSourceStore(join(directory, 'sources'));
  const artifacts = await createArtifactStore(join(directory, 'artifacts'));
  const publications = await createPublicationStore(join(directory, 'publications'), { sources, artifacts });
  const memory = await createMemoryStore(join(directory, 'memory'));
  const compactions = await createCompactionStore(join(directory, 'compactions'));
  const messages = () => [{ role: 'user', text: store.run.task, messageId: store.run.initialMessageId },
    ...store.events().flatMap(event => event.scope !== 'root' ? [] : event.type === 'assistant'
      ? [{ role: 'assistant', text: event.text, calls: event.calls, turnId: event.turnId, requestId: event.requestId }]
      : event.type === 'tool-result' ? [{ role: 'tool', callId: event.callId, result: event.result }] : [])];
  return { store, sources, artifacts, publications, memory, compactions, messages, close: () => store.close() };
}

// This fixture chooses calls, arguments and prose. It is not a model quality test.
export function createFixtureGateway() {
  return {
    fixture: true,
    async next({ messages, fixtureHistory }) {
      const tools = (fixtureHistory ?? messages).filter(m => m.role === 'tool');
      const output = name => tools.find(m => m.result.toolName === name)?.result;
      const step = tools.length;
      const call = (name, args) => ({ text: '', calls: [{ id: `fixture-${step}-${name}`, name, args }] });
      if (!output('read_skill_resource')) return call('read_skill_resource', { resourceId: 'compare-manuals' });
      if (!output('search_documents')) return call('search_documents', { query: '导出 格式 上限' });
      if (!output('delegate_reads')) return call('delegate_reads', { documentIds: ['manual-a-v1', 'manual-b-v2'] });
      const children = output('delegate_reads').children;
      if (children.some(child => child.status !== 'completed' || child.output?.status === 'partial')) return { text: '当前只取得部分页，已保留原窗口。材料不足以完成整份比较，请用新运行安排剩余读取。', calls: [] };
      const ids = children.flatMap(child => child.sourceIds);
      const read = tools.filter(m => m.result.toolName === 'read_result');
      if (read.length < 2) return call('read_result', { sourceId: children[read.length].sourceIds[0] });
      if (!output('read_metrics')) return call('read_metrics', { sourceIds: [children[0].sourceIds[1], children[1].sourceIds[1]] });
      if (!output('search_memory')) return call('search_memory', { query: '' });
      if (!output('commit_memory')) return call('commit_memory', { operation: 'save', summary: '以后比较产品时先列限制。' });
      if (!output('calculate_limits')) return call('calculate_limits', {});
      if (!output('publish_report')) {
        const values = output('calculate_limits');
        return call('publish_report', { body: `# 两版手册比较\n\n先看限制：导出均不含操作历史。\n\nA 版仅支持 Markdown [1]；B 版支持 Markdown 和 PDF [3]。\n\n每次导出上限由 ${values.before} 条 [2] 增至 ${values.after} 条 [4]，增加 ${values.increase} 条，为原来的 ${values.ratio} 倍。\n\n资料仅为教学合成手册。`, sourceIds: ids });
      }
      return { text: '报告已保存。可在本机阅读页回看原页，并下载报告、数据和图表。', calls: [] };
    },
    async summarize({ references }) { return `已加载比较方法并完成两版手册的范围内读取。原始窗口保留在 ${references.map(r => r.sourceId).join('、')}；这段摘要是派生工作笔记。`; },
  };
}

export async function runWorkbench({ directory, initial = {}, gateway = createFixtureGateway(), afterPublish, signal } = {}) {
  const gatewayMode = gateway.fixture ? 'fixture' : 'chat-completions';
  const work = await openWorkbench(directory, { ...initial, gatewayMode });
  const { store, sources, artifacts, publications, memory, compactions } = work;
  let host, cancelTimer;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    if (store.run.gatewayMode !== gatewayMode) throw new Error('Resume with the original gateway mode; live runs require --live again');
    if (store.events().some(e => e.type === 'completed')) return { status: 'completed', reused: true, directory };
    if (store.cancelled()) return { status: 'paused', reason: 'Run cancelled', directory };
    await store.claim();
    cancelTimer = setInterval(() => { if (store.cancelled()) controller.abort(); }, 100);
    cancelTimer.unref();
    const budget = new SharedBudget(store.run.budget);
    for (const event of store.events()) {
      if (event.type === 'model-request') budget.consume('modelRequests');
      if (event.type === 'tool-start') budget.consume('toolCalls');
    }
    const check = () => { if (controller.signal.aborted || store.cancelled()) throw new Paused('Run cancelled'); };
    async function requestModel({ kind, turnId, generation, invoke }) {
      check();
      if (!budget.consume('modelRequests')) throw new Paused(`Shared ${kind === 'summary' ? 'summary' : 'model'} budget exhausted`);
      const requestId = `request-${store.events().filter(event => event.type === 'model-request').length + 1}`;
      await store.record({ type: 'model-request', requestId, kind, ...(turnId ? { turnId } : {}), ...(generation !== undefined ? { generation } : {}) });
      const started = performance.now();
      let usage;
      try {
        const value = await invoke({ onUsage: reported => { usage = usageMetadata(reported); } });
        await store.recordObservation({ type: 'model-result', requestId, kind, status: 'returned', durationMs: performance.now() - started, usage: usageMetadata(value?.usage) ?? usage });
        return { value, requestId };
      } catch (error) {
        await store.recordObservation({ type: 'model-result', requestId, kind, status: 'failed', durationMs: performance.now() - started, usage });
        throw error;
      }
    }
    const registry = createToolRegistry();
    const register = (name, description, inputSchema, execute) => registry.register(name, { description, inputSchema, execute });
    const skill = await createSkillCatalog([{ resourceId: 'compare-manuals', name: '比较两份手册', description: '逐页保留条件和出处', content: await readFile(new URL('../fixtures/compare-skill.md', import.meta.url), 'utf8') }]);
    register('read_skill_resource', 'Read the supplied comparison Skill. No filesystem paths accepted.', object({ resourceId: string }), args => skill.read(args));
    register('search_documents', 'Find candidate pages in the original Run grant; read them before citing.', object({ query: string }), async ({ query }) => ({ status: 'ok', candidates: retrieveDocuments({ documents: manuals, query, documentIds: store.run.grant.documentIds }).map(({ text, ...candidate }) => ({ ...candidate, excerpt: text.slice(0, 80) })) }));
    register('read_page', 'Read an authorized page and record its immutable original window.', object({ documentId: string, page: { type: 'integer', minimum: 1 } }), async ({ documentId, page }, context) => {
      if (!context.grant.documentIds.includes(documentId)) return { status: 'denied', reason: 'outside_document_grant' };
      const document = manuals[documentId], text = document?.pages[page - 1];
      if (text === undefined) return { status: 'failed', reason: 'page_not_found' };
      const ref = await store.effect(() => sources.put({ readId: `${store.run.id}:${context.callId}`, documentId, title: document.title, version: document.version, page, text }));
      return { status: 'ok', sourceId: ref.id, source: ref, text };
    });
    register('read_result', 'Reopen a registered original read window by sourceId.', object({ sourceId: string }), async ({ sourceId }, context) => {
      const source = await sources.get(sourceId);
      if (!source || !context.grant.documentIds.includes(source.documentId)) return { status: 'unavailable', sourceId };
      const { text, ...ref } = source;
      return { status: 'ok', sourceId, text, source: ref };
    });
    register('delegate_reads', 'Read export format and limit pages in parallel with narrower document grants.', object({ documentIds: strings }), async ({ documentIds }, context) => {
      const children = await runSubagents({ tasks: documentIds.map((id, i) => ({ id: `reader-${i}`, documentIds: [id], instruction: '读取导出格式和上限页' })), grant: context.grant, budget, concurrency: 2,
        worker: async (task, child) => {
          const sourceIds = [];
          for (const page of [2, 4]) {
            let receipt;
            try { receipt = await perform({ id: `${context.callId}:${task.id}:page-${page}`, name: 'read_page', args: { documentId: task.documentIds[0], page } }, { scope: task.id, grant: child.grant, lease: context.lease, requestId: context.requestId }); }
            catch (error) {
              if (error instanceof Paused) return { sourceIds, output: { status: 'partial', reason: error.message, unfinishedPage: page } };
              throw error;
            }
            if (receipt.status !== 'ok') return { sourceIds, output: { status: 'partial', reason: `Child read returned ${receipt.status}` } };
            sourceIds.push(receipt.sourceId);
          }
          return { sourceIds, output: '两页原始窗口已登记。' };
        } });
      return { status: 'ok', coverage: children.every(child => child.status === 'completed' && child.output?.status !== 'partial') ? 'complete' : 'partial', children };
    });
    register('read_metrics', 'Load synthetic structured export limits for already read page-4 windows.', object({ sourceIds: strings }), async ({ sourceIds }, context) => {
      const inputs = [];
      for (const sourceId of sourceIds) {
        const source = await sources.get(sourceId);
        if (!source || source.page !== 4 || !context.grant.documentIds.includes(source.documentId)) return { status: 'failed', reason: 'not_an_authorized_metric_window' };
        inputs.push({ documentId: source.documentId, version: source.version, sourceId, maxExportRows: manuals[source.documentId].metrics.maxExportRows });
      }
      return { status: 'ok', inputs, fieldOrigin: 'synthetic-structured-fixture' };
    });
    register('search_memory', 'Search current user memory and issue version-bound mutation targets.', object({ query: { type: 'string' } }), async ({ query }) => ({ status: 'ok', matches: await store.effect(() => memory.search(query)) }));
    register('commit_memory', 'Save an explicitly requested preference; Host assigns operation identity. Forget/update requires a searched target.', {
      type: 'object', properties: { operation: { type: 'string', enum: ['save', 'forget'] }, summary: { type: 'string' }, targetRef: string }, required: ['operation'], additionalProperties: false,
    }, async (args, context) => ({ status: 'ok', receipt: await store.effect(() => memory.commit({ ...args, operationId: operation(store.run.id, context.callId), sourceMessageId: store.run.initialMessageId })) }));
    register('calculate_limits', 'Calculate change from two stored structured inputs, preserving code and source lineage.', object({}), async () => {
      const inputEvent = store.events().findLast(e => e.type === 'tool-result' && e.name === 'read_metrics' && e.result.status === 'ok');
      const inputs = inputEvent?.result.inputs;
      if (!inputs || inputs.length !== 2 || inputs[0].documentId !== 'manual-a-v1' || inputs[1].documentId !== 'manual-b-v2') return { status: 'failed', reason: 'read_both_structured_inputs_in_A_B_order' };
      return { status: 'ok', ...calculate(inputs[0].maxExportRows, inputs[1].maxExportRows), codeHash: calculationHash, inputSourceIds: inputs.map(i => i.sourceId), inputs };
    });
    register('publish_report', 'Preview and durably save body, fixed citation slots and registered downloadable files. Body remains independent of missing attachments.', object({ body: { type: 'string' }, sourceIds: strings }), async ({ body, sourceIds }, context) => {
      const id = 'comparison', operationId = operation(store.run.id, context.callId);
      // This example creates one report. Recovery must reuse this exact CAS basis.
      const expectedRevision = 0;
      await publications.preview({ id, revision: 1, body, sourceIds });
      const calc = store.events().findLast(e => e.type === 'tool-result' && e.name === 'calculate_limits' && e.result.status === 'ok')?.result;
      const specs = [
        { id: 'report-md', filename: 'comparison.md', mediaType: 'text/markdown; charset=utf-8', bytes: body },
        { id: 'report-html', filename: 'comparison.html', mediaType: 'text/html; charset=utf-8', bytes: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>手册比较</title><pre style="white-space:pre-wrap;font:18px/1.7 system-ui">${escapeHtml(body)}</pre>` },
      ];
      if (calc) specs.push(
        { id: 'limits-csv', filename: 'limits.csv', mediaType: 'text/csv; charset=utf-8', bytes: `version,maxExportRows\nA,${calc.before}\nB,${calc.after}\n` },
        { id: 'limits-chart', filename: 'limits.svg', mediaType: 'image/svg+xml', bytes: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 240"><rect width="360" height="240" rx="18" fill="#f4f5fb"/><g font-family="sans-serif" fill="#24304d"><text x="28" y="38" font-size="20">Export limit</text><text x="28" y="90">A</text><text x="28" y="152">B</text><rect x="60" y="65" width="48" height="32" rx="6" fill="#85a5ed"/><rect x="60" y="127" width="240" height="32" rx="6" fill="#5672d8"/><text x="118" y="87">${calc.before}</text><text x="260" y="185">${calc.after}</text><text x="28" y="218" font-size="12">Synthetic manual data</text></g></svg>` },
      );
      const artifactIds = [];
      for (const spec of specs) {
        const record = await store.effect(() => artifacts.save({ ...spec, inputSourceIds: sourceIds }));
        artifactIds.push(record.id);
      }
      const result = await store.effect(() => publications.commit({ id, operationId, expectedRevision, body, sourceIds, artifactIds }));
      await afterPublish?.(result);
      return { status: 'ok', publicationId: id, revision: result.revision, artifactIds };
    });
    host = createExtensionHost({ registry });
    const activated = await host.activate({ name: 'manual-desk', version: '1.0.0', contribute: async () => ({ skills: skill.list(), hooks: [{ id: 'audit-receipts', after: async receipt => {
      await store.record({ type: 'hook-observation', callId: receipt.id, status: receipt.status, dispatched: receipt.dispatched });
    } }] }) });
    if (activated.status !== 'active') throw new Error(activated.error.message);
    const pending = new Map();
    async function perform(call, { scope = 'root', grant = store.run.grant, lease, requestId } = {}) {
      const key = canonical({ name: call.name, args: call.args, scope });
      const prior = store.events().find(e => e.type === 'tool-start' && e.callId === call.id);
      requestId ??= prior?.requestId;
      if (prior && prior.key !== key) throw new Error('Call identity has different parameters');
      const recorded = store.events().find(e => e.type === 'tool-result' && e.callId === call.id);
      if (recorded) return recorded.result;
      if (pending.has(call.id)) {
        if (pending.get(call.id).key !== key) throw new Error('Concurrent call identity has different parameters');
        return pending.get(call.id).promise;
      }
      const promise = (async () => {
        check();
        if (!prior) {
          if (!budget.consume('toolCalls')) throw new Paused('Shared tool budget exhausted');
          await store.record({ type: 'tool-start', callId: call.id, requestId, name: call.name, args: call.args, key, scope });
        }
        const started = performance.now();
        const receipt = await lease.dispatch(call, { callId: call.id, requestId, scope, grant, lease });
        const result = receipt.status === 'completed' ? { status: 'ok', ...receipt.output, toolName: call.name }
          : { status: 'failed', error: receipt.error, toolName: call.name };
        await store.record({ type: 'tool-result', callId: call.id, requestId, name: call.name, scope, durationMs: performance.now() - started, receipt, result });
        return result;
      })();
      pending.set(call.id, { key, promise });
      try { return await promise; } finally { pending.delete(call.id); }
    }
    async function compact() {
      if ((await compactions.list()).length || work.messages().filter(m => m.role === 'assistant' && m.calls?.length).length < 6) return;
      const history = work.messages();
      const lastAssistant = history.findLastIndex(m => m.role === 'assistant');
      const range = history.slice(0, lastAssistant);
      if (typeof gateway.summarize !== 'function') return;
      const segment = await summarizeSettledTurns({ messages: range, id: 'settled-opening', basis: 'derived-working-note', summarize: async basis => {
        const { value } = await requestModel({ kind: 'summary', invoke: options => gateway.summarize(basis, { signal: controller.signal, ...options }) });
        return value;
      } });
      if (segment) await store.effect(() => compactions.commit(segment));
    }
    async function project() {
      let messages = work.messages();
      const segments = await compactions.list();
      for (const segment of segments) {
        const ids = new Set(segment.modelTurnIds), removedCalls = new Set(messages.filter(m => ids.has(m.turnId)).flatMap(m => m.calls.map(c => c.id)));
        messages = messages.filter(m => !ids.has(m.turnId) && !(m.role === 'tool' && removedCalls.has(m.callId)));
        messages.splice(1, 0, { role: 'system', text: `派生工作笔记；不能替代执行回执：${segment.summary}\n原始窗口：${JSON.stringify(segment.references)}` });
      }
      const memoryRecords = await memory.recall();
      const projected = await buildContext({ messages, sources, memoryRecords, maxChars: 32_000 });
      if (!projected.fits) throw new Paused('Context capacity requires a new explicit strategy');
      await store.record({ type: 'context-projection', charCount: projected.charCount, externalizedSourceIds: projected.externalizedSourceIds, summaryIds: segments.map(s => s.id) });
      // Context is a projection; the persisted transcript remains available for recovery.
      return [{ role: 'system', text: `你比较两份已授权的合成手册。按需读取Skill。候选不是引用；必须读取原页。调用工具保存后才可声称已保存。不要将摘要当作执行事实。用户偏好：${JSON.stringify(memoryRecords)}\nSkills:${JSON.stringify(skill.list())}` }, ...projected.messages];
    }
    while (true) {
      check();
      const lease = host.acquire();
      try {
        const history = work.messages(), latest = history.findLast(m => m.role === 'assistant');
        if (latest && latest.calls.length === 0) {
          await store.record({ type: 'completed', text: latest.text, budget: budget.snapshot() });
          return { status: 'completed', reused: true, text: latest.text, directory };
        }
        const uncompleted = latest?.calls?.filter(call => !history.some(m => m.role === 'tool' && m.callId === call.id)) ?? [];
        if (uncompleted.length) { for (const call of uncompleted) await perform(call, { lease, requestId: latest.requestId }); continue; }
        await compact();
        const messages = await project();
        const turnId = `turn-${store.events().filter(e => e.type === 'model-request').length + 1}`;
        const { value: next, requestId } = await requestModel({ kind: 'turn', turnId, generation: lease.generation,
          invoke: () => gateway.next({ messages, tools: lease.descriptions(), signal: controller.signal, fixtureHistory: gateway.fixture ? work.messages() : undefined }) });
        check();
        if (next.complete === false) {
          await store.record({ type: 'draft', scope: 'root', requestId, text: next.text, finishReason: next.finishReason });
          return { status: 'paused', reason: `Provider stopped: ${next.finishReason}`, text: next.text, directory };
        }
        if (typeof next.text !== 'string' || !Array.isArray(next.calls)) throw new Error('Gateway returned an invalid turn');
        if (new Set(next.calls.map(c => c.id)).size !== next.calls.length || next.calls.some(c => !c.id || !c.name || !c.args || typeof c.args !== 'object')) throw new Error('Gateway returned invalid call identities');
        const existingIds = new Set(store.events().filter(e => e.type === 'tool-start').map(e => e.callId));
        if (next.calls.some(c => existingIds.has(c.id))) throw new Error('Gateway reused a previous call identity');
        await store.record({ type: 'assistant', scope: 'root', turnId, requestId, text: next.text, calls: next.calls, usage: next.usage });
        if (!next.calls.length) {
          await store.record({ type: 'completed', text: next.text, budget: budget.snapshot() });
          return { status: 'completed', directory, budget: budget.snapshot(), text: next.text };
        }
        for (const call of next.calls) await perform(call, { lease, requestId });
      } finally { await lease.release(); }
    }
  } catch (error) {
    if (error instanceof Paused || controller.signal.aborted || store.cancelled()) return { status: 'paused', reason: error.message, directory };
    throw error;
  } finally { clearInterval(cancelTimer); signal?.removeEventListener('abort', abort); await host?.dispose(); await work.close(); }
}
