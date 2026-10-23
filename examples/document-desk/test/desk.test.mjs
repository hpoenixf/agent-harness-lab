import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDesk, scriptedGateway } from '../src/desk.mjs';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'document-desk-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('a complete report preserves two different versions and a readable artifact', async t => {
  const directory = await workspace(t);
  const desk = await openDesk(directory);
  await desk.drive(scriptedGateway());
  const publication = desk.events().find(event => event.receipt?.publication).receipt.publication;
  assert.deepEqual(publication.citations.map(citation => [citation.number, citation.source.version, citation.source.page]), [[1, '1.0', 2], [2, '2.0', 2]]);
  const exported = await readFile(join(directory, publication.attachment.path), 'utf8');
  assert(exported.startsWith(publication.body));
  assert.match(exported, /\[1\] 产品手册 A（1.0），第 2 页/);
  assert.match(exported, /\[2\] 产品手册 B（2.0），第 2 页/);
  assert.match(publication.body, /新版新增 PDF 导出/);
  const recovered = await openDesk(directory);
  await recovered.drive({ next() { throw new Error('A completed run must not request the model again'); } });
});

test('a new process recovers after an effect without creating a second report', async t => {
  const directory = await workspace(t);
  const demo = fileURLToPath(new URL('../src/demo.mjs', import.meta.url));
  const interrupted = spawnSync(process.execPath, [demo, '--state', directory, '--interrupt-after-save'], { encoding: 'utf8' });
  assert.equal(interrupted.status, 75, interrupted.stderr);
  const artifact = join(directory, 'artifacts/save-report/report.md');
  const original = await stat(artifact);
  const resumed = spawnSync(process.execPath, [demo, '--state', directory], { encoding: 'utf8' });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal((await stat(artifact)).mtimeMs, original.mtimeMs);
  assert.deepEqual(await readdir(join(directory, 'artifacts')), ['save-report']);
  const desk = await openDesk(directory);
  assert.equal(desk.events().filter(event => event.type === 'tool_returned' && event.callId === 'save-report').length, 1);
});

test('document scope is local to the call and the next authorized read still succeeds', async t => {
  const desk = await openDesk(await workspace(t), { documentIds: ['manual-a-v1'] });
  assert.equal((await desk.perform({ id: 'outside', name: 'read_page', args: { documentId: 'manual-b-v2', page: 2 } })).status, 'denied');
  assert.equal((await desk.perform({ id: 'inside', name: 'read_page', args: { documentId: 'manual-a-v1', page: 2 } })).status, 'ok');
});

test('recovery inherits the original grant and a call id remains bound to its arguments', async t => {
  const directory = await workspace(t);
  const desk = await openDesk(directory, { documentIds: ['manual-a-v1'] });
  const call = { id: 'page', name: 'read_page', args: { documentId: 'manual-a-v1', page: 2 } };
  await desk.perform(call);
  const recovered = await openDesk(directory, { documentIds: ['manual-b-v2'] });
  assert.deepEqual(recovered.run.grant.documentIds, ['manual-a-v1']);
  await assert.rejects(recovered.perform({ ...call, args: { documentId: 'manual-a-v1', page: 1 } }), /different arguments/);
});

test('an unavailable citation keeps its number while the body and later source remain usable', async t => {
  const directory = await workspace(t);
  const desk = await openDesk(directory);
  const read = await desk.perform({ id: 'read', name: 'read_page', args: { documentId: 'manual-a-v1', page: 2 } });
  const body = '可独立交付的合成教学正文。[1] 已读取的补充出处。[2]';
  const receipt = await desk.perform({ id: 'report', name: 'publish_report', args: { body, sourceIds: ['missing-source', read.source.id] } });
  assert.equal(receipt.status, 'ok');
  assert.equal(receipt.publication.body, body);
  assert.equal(receipt.publication.citations[0].number, 1);
  assert.equal(receipt.publication.citations[0].status, 'unavailable');
  assert.equal(receipt.publication.citations[1].number, 2);
  assert.equal(receipt.publication.citations[1].source.id, read.source.id);
  assert.deepEqual(receipt.publication.unavailableSources, ['missing-source']);
  const exported = await readFile(join(directory, receipt.publication.attachment.path), 'utf8');
  assert.match(exported, /\[1\] 来源暂不可用/);
  assert.match(exported, /\[2\] 产品手册 A/);
});
