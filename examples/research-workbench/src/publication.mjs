import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
function checkId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(id) || id.includes('..')) throw new Error('Invalid publication or operation identity');
}
function content(input) {
  checkId(input.id);
  const { body, sourceIds = [], artifactIds = [] } = input;
  if (typeof body !== 'string' || !Array.isArray(sourceIds) || !sourceIds.every(id => typeof id === 'string')
    || !Array.isArray(artifactIds) || !artifactIds.every(id => typeof id === 'string')) throw new Error('Expected body and source/artifact identities');
  return { id: input.id, body, sourceIds: [...sourceIds], artifactIds: [...artifactIds] };
}

// One active writer per directory. One atomically replaced state file keeps the
// revision and its operation receipt together, including during cold recovery.
export async function createPublicationStore(directory, { sources, artifacts }) {
  await mkdir(directory, { recursive: true });
  const statePath = join(directory, 'state.json');
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { publications: {}, operations: {} }; }
  const previews = new Map();
  let pending = Promise.resolve();
  function serial(operation) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }
  async function persist(next) {
    const temporary = join(directory, `.state-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx');
    try {
      await file.writeFile(JSON.stringify(next) + '\n');
      await file.sync();
    } finally { await file.close(); }
    try { await rename(temporary, statePath); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    state = next;
  }
  async function project(value, revision, status) {
    const citations = [];
    for (const [index, sourceId] of value.sourceIds.entries()) {
      let source;
      try { source = await sources.get(sourceId); } catch { /* A missing source affects its slot only. */ }
      if (source) {
        const { text, ...ref } = source;
        citations.push({ number: index + 1, status: 'available', source: ref });
      } else citations.push({ number: index + 1, status: 'unavailable', sourceId });
    }
    const attachments = [];
    for (const artifactId of value.artifactIds) {
      let artifact;
      try { artifact = await artifacts.get(artifactId); } catch { /* Preserve the independent body. */ }
      attachments.push(artifact
        ? { status: 'available', artifact: artifact.record }
        : { status: 'unavailable', artifactId });
    }
    return { ...value, revision, status, citations, attachments };
  }
  function durable(id) { return state.publications[digest(id)]?.revisions.at(-1); }
  function visible(id) {
    const saved = durable(id);
    const preview = previews.get(id);
    return preview && (!saved || preview.revision > saved.revision) ? preview : saved;
  }
  async function preview(input) {
    const value = content(input);
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error('Expected a positive preview revision');
    return serial(async () => {
      const current = visible(value.id);
      if (current && (input.revision < current.revision || (input.revision === current.revision && current.status === 'committed'))) return clone(current);
      const projected = await project(value, input.revision, 'preview');
      previews.set(value.id, projected);
      return clone(projected);
    });
  }
  async function commit(input) {
    const value = content(input);
    checkId(input.operationId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('Expected a nonnegative revision');
    const parameters = { ...value, operationId: input.operationId, expectedRevision: input.expectedRevision };
    const fingerprint = JSON.stringify(parameters);
    return serial(async () => {
      const operationKey = digest(input.operationId);
      const prior = state.operations[operationKey];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('An operation identity cannot be reused with different parameters');
        return clone(prior.result);
      }
      const current = durable(value.id);
      if ((current?.revision ?? 0) !== input.expectedRevision) throw new Error('Publication revision conflict');
      const result = await project(value, input.expectedRevision + 1, 'committed');
      const next = clone(state);
      const key = digest(value.id);
      next.publications[key] ??= { id: value.id, revisions: [] };
      next.publications[key].revisions.push(result);
      next.operations[operationKey] = { fingerprint, result };
      await persist(next);
      if ((previews.get(value.id)?.revision ?? Infinity) <= result.revision) previews.delete(value.id);
      return clone(result);
    });
  }
  async function get(id, { revision } = {}) {
    checkId(id);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error('Invalid historical revision');
    const result = revision === undefined ? visible(id) : state.publications[digest(id)]?.revisions.find(value => value.revision === revision);
    return result && clone(result);
  }
  async function list() {
    const ids = new Set([...Object.values(state.publications).map(value => value.id), ...previews.keys()]);
    return [...ids].sort().map(id => clone(visible(id)));
  }
  return { preview, commit, replace: commit, get, list };
}
