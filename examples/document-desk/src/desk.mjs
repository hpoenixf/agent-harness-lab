import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// 合成资料；文档身份包含版本，回读始终指向同一份内容。
export const documents = Object.freeze({
  'manual-a-v1': Object.freeze({
    title: '产品手册 A', version: '1.0',
    pages: Object.freeze(['安装后可以浏览和搜索本地资料。', '离线导出支持 Markdown 和 PDF。']),
  }),
  'manual-b-v2': Object.freeze({
    title: '产品手册 B', version: '2.0',
    pages: Object.freeze(['安装后可以浏览和搜索本地资料。', '离线导出支持 Markdown。PDF 导出需要联网。']),
  }),
});

const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
};

async function writeOnce(path, content) {
  let file;
  try {
    file = await open(path, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(path, 'utf8') !== content) throw new Error('Existing artifact has different content');
    return;
  }
  try { await file.writeFile(content); await file.sync(); }
  finally { await file.close(); }
}

// 一个目录仅允许一个活动写入者；此例演示顺序冷恢复。
export async function openDesk(directory, options = {}) {
  await mkdir(directory, { recursive: true });
  const journalPath = join(directory, 'run.jsonl');
  let events;
  try {
    const source = await readFile(journalPath, 'utf8');
    events = source.trim().split('\n').map(line => JSON.parse(line));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    events = [];
  }
  async function record(event) {
    const file = await open(journalPath, 'a');
    try { await file.writeFile(JSON.stringify(event) + '\n'); await file.sync(); }
    finally { await file.close(); }
    events.push(event);
  }
  if (events.length === 0) {
    await record({ type: 'run_created', runId: 'comparison-1',
      task: '比较两版手册的离线导出，保留页码出处并生成报告。',
      grant: { documentIds: options.documentIds ?? Object.keys(documents) } });
  }
  // 冷恢复读取原 Run 的 Grant；options 不覆盖已有授权。
  const run = events[0];
  if (run.type !== 'run_created') throw new Error('Invalid run journal');

  function receipts() {
    return events.filter(event => event.type === 'tool_returned');
  }
  function messages() {
    const result = [{ role: 'user', text: run.task }];
    for (const event of events) {
      if (event.type === 'model_returned') result.push({ role: 'assistant', ...event.response });
      if (event.type === 'tool_returned') result.push({ role: 'tool', callId: event.callId, result: event.receipt });
    }
    return result;
  }
  async function execute(call) {
    if (call.name === 'read_page') {
      const { documentId, page } = call.args;
      if (!run.grant.documentIds.includes(documentId)) {
        return { status: 'denied', reason: 'Document is outside this Run grant' };
      }
      const document = documents[documentId];
      if (!document || !Number.isInteger(page) || page < 1 || page > document.pages.length) {
        return { status: 'error', reason: 'Page does not exist in this document version' };
      }
      const text = document.pages[page - 1];
      return { status: 'ok', text, source: {
        id: `${documentId}:p${page}:${digest(text).slice(0, 12)}`,
        documentId, title: document.title, version: document.version, page,
      } };
    }
    if (call.name === 'publish_report') {
      const { body, sourceIds } = call.args;
      if (typeof body !== 'string' || !Array.isArray(sourceIds)) {
        return { status: 'error', reason: 'Expected body and sourceIds' };
      }
      const available = new Map(receipts().filter(event => event.receipt.source)
        .map(event => [event.receipt.source.id, event.receipt.source]));
      const citations = sourceIds.map((id, index) => available.has(id)
        ? { number: index + 1, status: 'available', source: available.get(id) }
        : { number: index + 1, status: 'unavailable', sourceId: id });
      const unavailableSources = sourceIds.filter(id => !available.has(id));
      const sourceIndex = citations.map(citation => citation.status === 'available'
        ? `[${citation.number}] ${citation.source.title}（${citation.source.version}），第 ${citation.source.page} 页。`
        : `[${citation.number}] 来源暂不可用。`).join('\n');
      const exportedBody = body + (citations.length ? '\n## 来源\n\n' + sourceIndex + '\n' : '');
      const attachment = { path: `artifacts/${call.id}/report.md`, sha256: digest(exportedBody), mediaType: 'text/markdown' };
      const publication = { body, citations, unavailableSources, attachment };
      await mkdir(join(directory, 'artifacts', call.id), { recursive: true });
      await writeOnce(join(directory, attachment.path), exportedBody);
      await writeOnce(join(directory, 'artifacts', call.id, 'publication.json'), JSON.stringify(publication, null, 2) + '\n');
      return { status: 'ok', publication };
    }
    return { status: 'error', reason: 'Unknown tool' };
  }
  async function perform(call, { afterEffect } = {}) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(call.id)) throw new Error('Invalid call identity');
    const previous = events.find(event => event.type === 'tool_dispatched' && event.call.id === call.id);
    if (previous && canonical(previous.call) !== canonical(call)) {
      throw new Error('A call identity cannot be reused with different arguments');
    }
    const completed = receipts().find(event => event.callId === call.id);
    if (completed) return completed.receipt;
    if (!previous) await record({ type: 'tool_dispatched', call });
    const receipt = await execute(call);
    // 用于演示关键窗口：效果已经产生，本地回执还没写下。
    await afterEffect?.(call, receipt);
    await record({ type: 'tool_returned', callId: call.id, receipt });
    return receipt;
  }
  async function drive(gateway, { afterEffect, maxRequests = 8 } = {}) {
    const ended = events.find(event => event.type === 'run_completed');
    if (ended) return ended.text;
    while (true) {
      const last = events.findLast(event => event.type === 'model_returned');
      if (last) {
        for (const call of last.response.calls) await perform(call, { afterEffect });
        if (last.response.calls.length === 0) {
          await record({ type: 'run_completed', text: last.response.text });
          return last.response.text;
        }
      }
      const used = events.filter(event => event.type === 'model_request_started').length;
      if (used >= maxRequests) throw new Error('Recorded model request budget is exhausted');
      await record({ type: 'model_request_started', request: used + 1 });
      const response = await gateway.next({ messages: messages() });
      if (!Array.isArray(response.calls)) throw new Error('Gateway response must contain calls');
      await record({ type: 'model_returned', response });
    }
  }
  return { run, perform, drive, messages, events: () => structuredClone(events) };
}

// 确定性替身：让运行链条可观察，不声称这里测试了模型的研究能力。
export function scriptedGateway() {
  return {
    async next({ messages }) {
      const results = messages.filter(message => message.role === 'tool');
      const reads = results.filter(message => message.result.source);
      if (reads.length < 2) return { text: '', calls: [
        { id: 'read-a', name: 'read_page', args: { documentId: 'manual-a-v1', page: 2 } },
        { id: 'read-b', name: 'read_page', args: { documentId: 'manual-b-v2', page: 2 } },
      ] };
      const saved = results.find(message => message.result.publication);
      if (!saved) return { text: '', calls: [{ id: 'save-report', name: 'publish_report', args: {
        body: '# 两版手册的离线导出\n\nA 版可离线导出 Markdown 和 PDF。[1]\nB 版仍可离线导出 Markdown，PDF 导出需要联网。[2]\n\n变化集中在 PDF 导出条件。\n',
        sourceIds: reads.map(message => message.result.source.id),
      } }] };
      return { text: '报告已保存，可按引用回读两版手册第 2 页。', calls: [] };
    },
  };
}
