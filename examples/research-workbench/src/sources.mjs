import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);

// One active writer per directory. Source identity belongs to the read operation,
// not to the current document title or a later search result.
export async function createSourceStore(directory) {
  await mkdir(directory, { recursive: true });
  let pending = Promise.resolve();
  const serial = operation => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  async function get(id) {
    if (typeof id !== 'string' || !/^source-[a-f0-9]{64}$/.test(id)) return undefined;
    try { return JSON.parse(await readFile(join(directory, id + '.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
  async function put(input) {
    const { readId, documentId, title, version, page, text, representation = 'plain-text' } = input;
    if (![readId, documentId, title, version, text, representation].every(value => typeof value === 'string')
      || !readId || !documentId || !Number.isInteger(page) || page < 1) {
      throw new Error('Expected a read identity, document version, positive page and original text');
    }
    const id = 'source-' + hash(readId);
    const record = { id, readId, documentId, title, version, page, hash: hash(text), representation, text };
    return serial(async () => {
      const previous = await get(id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(record)) {
        throw new Error('A read identity cannot be reused with different parameters');
      }
      if (!previous) await writeFile(join(directory, id + '.json'), JSON.stringify(record) + '\n', { flag: 'wx' });
      const { text: originalText, ...ref } = record;
      return clone(ref);
    });
  }
  async function list() {
    const refs = [];
    for (const name of (await readdir(directory)).sort()) {
      if (!/^source-[a-f0-9]{64}\.json$/.test(name)) continue;
      const { text, ...ref } = await get(name.slice(0, -5));
      refs.push(ref);
    }
    return refs;
  }
  return { put, get, list };
}
