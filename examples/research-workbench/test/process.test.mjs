import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWorkbench } from '../src/workbench.mjs';
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const launch = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', code => resolve({ code, stdout, stderr }));
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('process exits after durable publication, then cold recovery replays the same effect identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await launch(['demo', '--state', directory, '--interrupt-after-save']);
  assert.equal(first.code, 75, first.stderr);
  let work = await openWorkbench(directory);
  const before = await work.publications.get('comparison');
  assert.equal(before.revision, 1);
  assert.equal(work.store.events().filter(e => e.type === 'tool-result' && e.name === 'publish_report').length, 0);
  await work.close();
  // A crashed owner retains its lease until expiry; do not infer death from a PID.
  await delay(10_100);
  const recovered = await launch(['resume', '--state', directory]);
  assert.equal(recovered.code, 0, recovered.stderr);
  work = await openWorkbench(directory);
  t.after(() => work.close());
  assert.deepEqual(await work.publications.get('comparison'), before);
  assert.equal((await work.artifacts.list()).length, 4);
  assert.equal(work.store.events().filter(e => e.type === 'tool-result' && e.name === 'publish_report').length, 1);
});

test('detached worker outlives its launcher and the reader reloads new durable output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-background-'));
  let reader;
  t.after(async () => {
    if (reader) { reader.kill('SIGTERM'); await new Promise(resolve => reader.once('close', resolve)); }
    await rm(directory, { recursive: true, force: true });
  });
  reader = spawn(process.execPath, [cli, 'serve', '--state', directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    reader.stdout.once('data', chunk => resolve(chunk.toString().trim()));
    reader.once('error', reject);
  });
  assert.deepEqual(await (await fetch(url + '/api/publications')).json(), []);
  const launched = await launch(['background', '--state', directory]);
  assert.equal(launched.code, 0, launched.stderr);
  assert.equal(JSON.parse(launched.stdout).status, 'started');
  let reports = [];
  for (let i = 0; i < 100; i++) {
    reports = await (await fetch(url + '/api/publications')).json();
    if (reports.length) break;
    await delay(30);
  }
  assert.equal(reports[0]?.status, 'committed');
  const download = await fetch(url + '/api/artifacts/report-md');
  assert.equal(download.status, 200);
  assert.match(await download.text(), /Markdown.*PDF/s);
  assert.equal((await fetch(url + '/api/publications', { method: 'POST' })).status, 405);
  // Allow the independent worker to release its lease before fixture cleanup.
  for (let i = 0; i < 100; i++) {
    const work = await openWorkbench(directory);
    const complete = work.store.events().some(e => e.type === 'completed');
    await work.close();
    if (complete) break;
    await delay(20);
  }
});
