import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const canonical = value => JSON.stringify(value, function (key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item;
});
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const settled = new Set(['ok', 'completed', 'denied', 'error', 'failed', 'not-dispatched']);

// Deterministic lexical recall, not a semantic relevance or permission verdict.
export function retrieveDocuments({ documents, query, documentIds = Object.keys(documents), limit = 6 }) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid candidate limit');
  const words = [...new Set(String(query).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const terms = words.flatMap(word => /^\p{Script=Han}+$/u.test(word) && word.length > 2
    ? [word, ...Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))] : [word]);
  const candidates = [];
  for (const documentId of new Set(documentIds)) {
    const document = documents[documentId];
    if (!document) continue;
    document.pages.forEach((text, index) => {
      const normalized = text.normalize('NFKC').toLowerCase();
      const score = terms.reduce((sum, term) => sum + Number(normalized.includes(term)), 0);
      if (score > 0) candidates.push({ documentId, version: document.version, page: index + 1, text, score });
    });
  }
  return candidates.sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId) || a.page - b.page).slice(0, limit);
}

function groupsIn(messages) {
  const groups = [];
  for (let index = 0; index < messages.length; index++) {
    const assistant = messages[index];
    if (assistant.role !== 'assistant' || !assistant.calls?.length) continue;
    const calls = new Set(assistant.calls.map(call => call.id));
    const tools = [];
    for (let i = index + 1; i < messages.length && !['assistant', 'user'].includes(messages[i].role); i++) {
      if (messages[i].role === 'tool') tools.push({ index: i, message: messages[i] });
    }
    const complete = calls.size === assistant.calls.length && tools.length === calls.size
      && tools.every(tool => calls.has(tool.message.callId) && settled.has(tool.message.result?.status))
      && [...calls].every(id => tools.filter(tool => tool.message.callId === id).length === 1);
    groups.push({ assistant, tools, complete });
  }
  return groups;
}

// Source.get is the caller's original authorized window reader; no fetching here.
export async function buildContext({ messages, sources, memoryRecords = [], maxChars = 12_000 }) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('Invalid context capacity');
  const projected = structuredClone(messages);
  const memory = structuredClone(memoryRecords);
  const externalizedSourceIds = [];
  const size = () => JSON.stringify({ messages: projected, memoryRecords: memory }).length;
  const groups = groupsIn(projected);
  for (const group of groups.slice(0, -1)) {
    if (size() <= maxChars) break;
    if (!group.complete) continue;
    for (const tool of group.tools) {
      if (size() <= maxChars) break;
      const result = tool.message.result;
      if (typeof result.sourceId !== 'string' || typeof result.text !== 'string') continue;
      let stored;
      try { stored = await sources?.get(result.sourceId); } catch { continue; }
      if (!stored || stored.text !== result.text
        || (stored.sourceId !== undefined && stored.sourceId !== result.sourceId)
        || (stored.id !== undefined && stored.id !== result.sourceId)) continue;
      const replacement = { ...result, representation: 'reference-only' };
      delete replacement.text;
      if (JSON.stringify(replacement).length >= JSON.stringify(result).length) continue;
      projected[tool.index] = { ...tool.message, result: replacement };
      externalizedSourceIds.push(result.sourceId);
    }
  }
  return { messages: projected, memoryRecords: memory, fits: size() <= maxChars, charCount: size(), externalizedSourceIds };
}

// The caller selects the history range. User messages never go to the summarizer.
export async function summarizeSettledTurns({ messages, summarize, id, basis }) {
  if (!id || !basis) throw new Error('A summary needs an id and its original basis');
  const groups = groupsIn(messages);
  if (!groups.length || groups.some(group => !group.complete)) return null;
  const turns = groups.map(group => ({ assistant: group.assistant, tools: group.tools.map(tool => tool.message) }));
  const modelTurnIds = turns.map(turn => turn.assistant.turnId ?? `turn-${hash(turn).slice(0, 16)}`);
  const sourceTurnHashes = turns.map(hash);
  const references = turns.flatMap(turn => turn.tools.flatMap(tool => typeof tool.result.sourceId === 'string'
    ? [{ callId: tool.callId, sourceId: tool.result.sourceId }] : []));
  const summary = await summarize(structuredClone({ turns, modelTurnIds, references }));
  if (typeof summary !== 'string' || !summary.trim()) throw new Error('The summarizer did not return text');
  // This is a derived working note, never proof of successful tool execution.
  return { id, modelTurnIds, sourceTurnHashes, summary, references, basis };
}

async function writeAtomic(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx');
    try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, filename);
  } finally { await unlink(temporary).catch(() => {}); }
}

// Caller creates a dedicated directory. One writer; await each mutation in order.
export async function createCompactionStore(directory) {
  const filename = join(directory, 'compactions.json');
  let state;
  try { state = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { segments: [] }; }
  if (!Array.isArray(state.segments)) throw new Error('Invalid compaction store');
  return {
    async commit(segment) {
      if (typeof segment.id !== 'string' || !segment.id || typeof segment.basis !== 'string' || !segment.basis
        || !Array.isArray(segment.modelTurnIds) || !segment.modelTurnIds.length
        || !Array.isArray(segment.sourceTurnHashes) || segment.sourceTurnHashes.length !== segment.modelTurnIds.length
        || segment.sourceTurnHashes.some(value => !/^[a-f0-9]{64}$/.test(value))
        || !Array.isArray(segment.references) || typeof segment.summary !== 'string' || !segment.summary.trim()) {
        throw new Error('Invalid summary segment');
      }
      const previous = state.segments.find(item => item.id === segment.id);
      if (previous) {
        if (canonical(previous) !== canonical(segment)) throw new Error('Summary id has different content');
        return structuredClone(previous);
      }
      const next = { segments: [...state.segments, structuredClone(segment)] };
      await writeAtomic(filename, next);
      state = next;
      return structuredClone(segment);
    },
    async get(id) { return structuredClone(state.segments.find(segment => segment.id === id)); },
    async list() { return structuredClone(state.segments); },
  };
}
