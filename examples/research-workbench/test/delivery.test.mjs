import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourceStore } from '../src/sources.mjs';
import { createArtifactStore } from '../src/artifacts.mjs';
import { createPublicationStore } from '../src/publication.mjs';
import { createReaderServer } from '../src/server.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-delivery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sources = await createSourceStore(join(directory, 'sources'));
  const artifacts = await createArtifactStore(join(directory, 'artifacts'));
  const publications = await createPublicationStore(join(directory, 'publications'), { sources, artifacts });
  return { directory, sources, artifacts, publications };
}
const read = { readId: 'read-original', documentId: 'guide', title: 'Synthetic guide', version: '1', page: 2, text: 'Original export supports Markdown.' };

test('source identity survives reopening and original windows stay immutable', async t => {
  const { directory, sources } = await fixture(t);
  const ref = await sources.put(read);
  assert.deepEqual(await sources.put(read), ref);
  await assert.rejects(sources.put({ ...read, text: 'Changed text' }), /different|reuse/i);
  const reopened = await createSourceStore(join(directory, 'sources'));
  assert.deepEqual(await reopened.get(ref.id), { ...ref, text: read.text });
  assert.deepEqual(await reopened.list(), [ref]);
});

test('historical citations retain source versions and fixed unavailable slots after cold opening', async t => {
  const { directory, sources, artifacts, publications } = await fixture(t);
  const original = await sources.put(read);
  const newer = await sources.put({ ...read, readId: 'read-new', version: '2', text: 'PDF is now supported.' });
  const first = await publications.commit({ id: 'report', operationId: 'save-1', expectedRevision: 0, body: 'Keep [1] and [2].', sourceIds: ['missing-source', original.id] });
  assert.equal(first.body, 'Keep [1] and [2].');
  assert.deepEqual(first.citations.map(c => [c.number, c.status]), [[1, 'unavailable'], [2, 'available']]);
  await publications.replace({ id: 'report', operationId: 'save-2', expectedRevision: 1, body: 'New body.', sourceIds: [newer.id] });
  const reopened = await createPublicationStore(join(directory, 'publications'), { sources, artifacts });
  const history = await reopened.get('report', { revision: 1 });
  assert.equal(history.citations[1].source.id, original.id);
  assert.equal((await sources.get(history.citations[1].source.id)).text, read.text);
  assert.equal((await reopened.get('report')).revision, 2);
});

test('publication CAS and immutable operations preserve newer previews', async t => {
  const { directory, sources, artifacts, publications } = await fixture(t);
  const args = { id: 'report', operationId: 'save-1', expectedRevision: 0, body: 'Durable one' };
  const first = await publications.commit(args);
  assert.deepEqual(await publications.commit(args), first);
  await assert.rejects(publications.commit({ ...args, body: 'Changed' }), /operation|different/i);
  await assert.rejects(publications.replace({ id: 'report', operationId: 'stale', expectedRevision: 0, body: 'Stale' }), /revision|conflict/i);
  await publications.preview({ id: 'report', revision: 3, body: 'Preview three' });
  await publications.replace({ id: 'report', operationId: 'save-2', expectedRevision: 1, body: 'Durable two' });
  assert.equal((await publications.get('report')).body, 'Preview three');
  await publications.preview({ id: 'report', revision: 2, body: 'Late preview' });
  assert.equal((await publications.get('report')).body, 'Preview three');
  await publications.replace({ id: 'report', operationId: 'save-3', expectedRevision: 2, body: 'Durable three' });
  assert.equal((await publications.get('report')).body, 'Durable three');
  await publications.preview({ id: 'report', revision: 3, body: 'Late same revision' });
  assert.equal((await publications.get('report')).body, 'Durable three');
  await assert.rejects(publications.commit({ ...args, id: 'other-report' }), /operation|different/i);
  const reopened = await createPublicationStore(join(directory, 'publications'), { sources, artifacts });
  assert.deepEqual(await reopened.commit(args), first);
  assert.equal((await reopened.get('report')).revision, 3);
});

test('registered artifact downloads match bytes; invalid attachment stays local', async t => {
  const { directory, sources, artifacts, publications } = await fixture(t);
  const bytes = Buffer.from('# Synthetic report\n\u0000\u00ff');
  const record = await artifacts.save({ id: 'report-file', filename: 'report.md', mediaType: 'text/markdown', bytes });
  assert.deepEqual(await artifacts.save({ id: 'report-file', filename: 'report.md', mediaType: 'text/markdown', bytes }), record);
  await assert.rejects(artifacts.save({ id: 'report-file', filename: 'report.md', mediaType: 'text/markdown', bytes: 'Changed' }), /different|reuse/i);
  await assert.rejects(artifacts.save({ id: 'escape', filename: '../secret', mediaType: 'text/plain', bytes: '' }), /filename|path/i);
  await assert.rejects(artifacts.get('../secret'), /identity|path/i);
  const reopened = await createArtifactStore(join(directory, 'artifacts'));
  assert.deepEqual((await reopened.get(record.id)).bytes, bytes);
  const jsonBytes = Buffer.from('{ "preserve": "exact spacing" }\n');
  await artifacts.save({ id: 'json-file', filename: 'report.json', mediaType: 'application/json', bytes: jsonBytes });
  const saved = await publications.commit({ id: 'report', operationId: 'save', expectedRevision: 0, body: '<script>bad()</script> remains text', artifactIds: ['missing', record.id] });
  assert.deepEqual(saved.attachments.map(a => a.status), ['unavailable', 'available']);
  const server = await createReaderServer({ sources, artifacts, publications });
  t.after(() => server.close());
  const response = await fetch(server.url + '/api/artifacts/' + record.id);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.deepEqual(Buffer.from(await (await fetch(server.url + '/api/artifacts/json-file')).arrayBuffer()), jsonBytes);
  assert.equal((await fetch(server.url + '/api/artifacts/%2e%2e%2fsecret')).status, 400);
  assert.equal((await fetch(server.url + '/api/artifacts/unknown')).status, 404);
  assert.equal((await fetch(server.url + '/api/publications/report')).status, 200);
  assert.equal((await fetch(server.url + '/api/publications/report', { method: 'POST' })).status, 405);
  const html = await (await fetch(server.url)).text();
  assert.match(html, /textContent/);
  assert.match(html, /name="viewport"/);
});
