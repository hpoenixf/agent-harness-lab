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
  assert.deepEqual(publication.citations.map(source => [source.version, source.page]), [['1.0', 2], ['2.0', 2]]);
  assert.equal(await readFile(join(directory, publication.attachment.path), 'utf8'), publication.body);
  assert.match(publication.body, /PDF 导出需要联网/);
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

test('an unavailable citation is omitted while the report body is delivered', async t => {
  const directory = await workspace(t);
  const desk = await openDesk(directory);
  const receipt = await desk.perform({ id: 'report', name: 'publish_report', args: { body: '可独立交付的合成教学正文。', sourceIds: ['missing-source'] } });
  assert.equal(receipt.status, 'ok');
  assert.equal(receipt.publication.body, '可独立交付的合成教学正文。');
  assert.deepEqual(receipt.publication.citations, []);
  assert.deepEqual(receipt.publication.unavailableSources, ['missing-source']);
});
