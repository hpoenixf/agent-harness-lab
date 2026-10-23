import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(id) && !id.includes('..');
const checkId = id => { if (!validId(id)) throw new Error('Invalid artifact identity or path'); };

// Registered metadata is the only way to locate a blob. A requested filename is
// display metadata, never a filesystem path accepted by the download route.
export async function createArtifactStore(directory) {
  const recordsDirectory = join(directory, 'records');
  const blobsDirectory = join(directory, 'blobs');
  await mkdir(recordsDirectory, { recursive: true });
  await mkdir(blobsDirectory, { recursive: true });
  let pending = Promise.resolve();
  async function recordFor(id) {
    checkId(id);
    try { return JSON.parse(await readFile(join(recordsDirectory, digest(id) + '.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
  async function save({ id, filename, mediaType, bytes, inputSourceIds = [] }) {
    checkId(id);
    if (typeof filename !== 'string' || !filename || filename !== basename(filename) || /[\\/\x00-\x1f\x7f]/.test(filename) || filename === '.' || filename === '..') {
      throw new Error('Artifact filename must be a plain filename without a path');
    }
    if (typeof mediaType !== 'string' || !/^[\w.+-]+\/[\w.+-]+(?:;[^\r\n]*)?$/.test(mediaType)) throw new Error('Invalid media type');
    if (!Array.isArray(inputSourceIds) || !inputSourceIds.every(value => typeof value === 'string')) throw new Error('Expected source identities');
    if (!(typeof bytes === 'string' || bytes instanceof Uint8Array)) throw new Error('Expected artifact bytes');
    const buffer = Buffer.from(bytes);
    const sha256 = digest(buffer);
    const record = { id, filename, mediaType, sha256, size: buffer.length, relativePath: `blobs/${sha256}.bin`, inputSourceIds: [...inputSourceIds] };
    const operation = pending.then(async () => {
      const previous = await recordFor(id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error('An artifact identity cannot be reused with different parameters');
      if (!previous) {
        try { await writeFile(join(blobsDirectory, sha256 + '.bin'), buffer, { flag: 'wx' }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        await writeFile(join(recordsDirectory, digest(id) + '.json'), JSON.stringify(record) + '\n', { flag: 'wx' });
      }
      return structuredClone(record);
    });
    pending = operation.catch(() => {});
    return operation;
  }
  async function get(id) {
    const record = await recordFor(id);
    if (!record) return undefined;
    // Reconstruct the internal path from the digest, rather than trusting a path.
    if (!/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('Invalid registered artifact digest');
    const bytes = await readFile(join(blobsDirectory, record.sha256 + '.bin'));
    if (digest(bytes) !== record.sha256 || bytes.length !== record.size) throw new Error('Registered artifact bytes do not match their receipt');
    return { record, bytes };
  }
  async function list() {
    const records = [];
    for (const name of (await readdir(recordsDirectory)).sort()) {
      if (/^[a-f0-9]{64}\.json$/.test(name)) records.push(JSON.parse(await readFile(join(recordsDirectory, name), 'utf8')));
    }
    return records;
  }
  return { save, get, list };
}
