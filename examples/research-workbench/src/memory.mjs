import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const canonical = value => JSON.stringify(value, function (key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item;
});
async function writeAtomic(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx');
    try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, filename);
  } finally { await unlink(temporary).catch(() => {}); }
}

// Dedicated caller-created directory, one writer, sequential awaited mutations.
// This module records Host-supplied operations; it never infers permission from prose.
export async function createMemoryStore(directory) {
  const filename = join(directory, 'memory.json');
  let state;
  try { state = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { records: [], operations: [], issuedTargets: [] }; }
  if (!Array.isArray(state.records) || !Array.isArray(state.operations)) throw new Error('Invalid memory store');
  // Existing stores predate durable search targets; only actually issued refs
  // can bind a later mutation to the family/version that the caller saw.
  state.issuedTargets ??= [];
  if (!Array.isArray(state.issuedTargets)) throw new Error('Invalid issued memory targets');
  const current = () => [...new Map(state.records.map(record => [record.familyId, record])).values()];
  const matching = query => {
    const words = String(query ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return current().filter(record => !record.forgotten
      && words.every(word => record.summary.normalize('NFKC').toLowerCase().includes(word)));
  };
  return {
    async search(query) {
      const results = matching(query).map(record => {
        const targetRef = `memory-target-${randomUUID()}`;
        return { targetRef, familyId: record.familyId, version: record.version, summary: record.summary };
      });
      if (results.length) {
        const issued = results.map(({ targetRef, familyId, version }) => ({ targetRef, familyId, version }));
        const next = { ...state, issuedTargets: [...state.issuedTargets, ...issued] };
        // Persist issuance before returning the search receipt. A later cold
        // worker retains this exact binding; it still must pass the CAS below.
        await writeAtomic(filename, next);
        state = next;
      }
      return results;
    },
    async recall(query) {
      return structuredClone(matching(query).map(({ familyId, version, summary, sourceMessageId }) => ({ familyId, version, summary, sourceMessageId })));
    },
    async commit(input) {
      const { operationId, operation, targetRef, summary, sourceMessageId } = input;
      if (typeof operationId !== 'string' || !operationId || typeof sourceMessageId !== 'string' || !sourceMessageId
        || !['save', 'forget'].includes(operation)) throw new Error('Invalid Host memory operation');
      const previous = state.operations.find(item => item.operationId === operationId);
      if (previous) {
        if (canonical(previous.input) !== canonical(input)) throw new Error('Operation id has different parameters');
        return structuredClone(previous.receipt);
      }
      const target = targetRef === undefined ? undefined : state.issuedTargets.find(item => item.targetRef === targetRef);
      if (targetRef !== undefined && !target) throw new Error('Unknown memory target reference');
      const record = target && current().find(item => item.familyId === target.familyId);
      if (target && (!record || record.forgotten || record.version !== target.version)) throw new Error('Stale memory target version');
      if (operation === 'forget' && !target) throw new Error('Forgetting needs an issued target reference');
      if (operation === 'save' && (typeof summary !== 'string' || !summary.trim())) throw new Error('Saving needs a summary');
      const familyId = record?.familyId ?? `memory-${randomUUID()}`;
      const version = (record?.version ?? 0) + 1;
      const nextRecord = { familyId, version, summary: operation === 'save' ? summary : record.summary,
        forgotten: operation === 'forget', sourceMessageId };
      const receipt = { operationId, status: operation === 'forget' ? 'forgotten' : record ? 'updated' : 'saved', familyId, version };
      const next = { ...state, records: [...state.records, nextRecord],
        operations: [...state.operations, { operationId, input: structuredClone(input), receipt }] };
      // One file replacement commits the new version and its operation receipt together.
      await writeAtomic(filename, next);
      state = next;
      return structuredClone(receipt);
    },
  };
}
