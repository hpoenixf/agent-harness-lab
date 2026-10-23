import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openRunStore } from '../src/storage.mjs';
import { createFixtureGateway, openWorkbench, runWorkbench } from '../src/workbench.mjs';

import * as observation from '../src/observability.mjs';
import * as evaluation from '../src/evaluation.mjs';
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'workbench-observation-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const launch = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.once('error', reject);
  child.once('close', code => resolve({ code, stdout, stderr }));
});

test('observe and evaluate refuse missing state without creating a Run', async t => {
  const root = await directory(t);
  for (const command of ['observe', 'evaluate']) {
    const absent = join(root, command);
    const result = await launch([command, '--state', absent]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /existing Run/i);
    await assert.rejects(stat(absent), { code: 'ENOENT' });
  }
});

test('legacy observation keeps unknown timings, usage and cost unknown and omits content', () => {
  assert.equal(typeof observation.summarizeObservation, 'function');
  const result = observation.summarizeObservation({ run: { id: 'run-legacy', gatewayMode: 'fixture', task: 'PRIVATE_TASK', apiKey: 'PRIVATE_KEY' }, events: [
    { seq: 1, type: 'model-request', kind: 'summary' },
    { seq: 2, type: 'tool-start', callId: 'c1', name: 'read_page', args: { private: 'PRIVATE_ARGUMENT' } },
    { seq: 3, type: 'tool-result', callId: 'c1', receipt: { dispatched: true }, result: { status: 'ok', text: 'PRIVATE_BODY' } },
  ] });
  assert.equal(result.execution.mode, 'fixture');
  assert.equal(result.execution.modelQualityEvidence, false);
  assert.equal(result.requests.recorded, 1);
  assert.equal(result.requests.summary, 1);
  assert.equal(result.requests.responseUnknown, 1);
  assert.equal(result.tools.dispatched, 1);
  assert.equal(result.usage.knownRequests, 0);
  assert.equal(result.usage.promptTokens, null);
  assert.equal(result.cost.amount, null);
  assert.ok(result.timeline.every(event => event.recordedAt === null && event.durationMs === null));
  assert.equal(/PRIVATE_/.test(JSON.stringify(result)), false);
});

test('Run timestamps and request observations include summaries without double accounting', async t => {
  const path = await directory(t);
  const fixture = createFixtureGateway();
  const gateway = { ...fixture,
    next: async input => ({ ...await fixture.next(input), usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }),
    summarize: async (input, options) => { options.onUsage({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }); return fixture.summarize(input); },
  };
  const result = await runWorkbench({ directory: path, gateway });
  assert.equal(result.status, 'completed');
  const report = await observation.observeRun(path);
  assert.equal(report.requests.summary, 1);
  assert.equal(report.requests.recorded, result.budget.modelRequests.used);
  assert.equal(report.requests.returned, report.requests.recorded);
  assert.equal(report.usage.knownRequests, report.requests.recorded);
  assert.equal(report.usage.unknownRequests, 0);
  assert.equal(report.usage.promptTokens, (report.requests.recorded - 1) * 10 + 5);
  assert.equal(report.tools.admitted, result.budget.toolCalls.used);
  assert.equal(report.tools.dispatched, report.tools.admitted);
  assert.equal(report.cost.amount, null);
  const responses = report.timeline.filter(event => event.type === 'model-result');
  assert.ok(responses.every(event => event.requestId && event.durationMs >= 0));
  const requestIds = new Set(report.timeline.filter(event => event.type === 'model-request').map(event => event.requestId));
  assert.ok(report.timeline.filter(event => event.type === 'tool-start' || event.type === 'tool-result').every(event => requestIds.has(event.requestId)));
  assert.ok(report.timeline.every(event => Number.isFinite(Date.parse(event.recordedAt))));
  assert.equal(JSON.stringify(report).includes('比较两版手册'), false);
  const cliResult = await launch(['observe', '--state', path]);
  assert.equal(cliResult.code, 0, cliResult.stderr);
  assert.equal(JSON.parse(cliResult.stdout).requests.recorded, report.requests.recorded);
});

test('Host supplies timestamps and extra telemetry failures do not erase a returned model answer', async t => {
  const path = await directory(t);
  const store = await openRunStore(path);
  await store.claim();
  const event = await store.record({ type: 'host-time', recordedAt: 'forged-time' });
  assert.ok(Number.isFinite(Date.parse(event.recordedAt)));
  await store.close();
  const runPath = join(path, 'run');
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (!sql.startsWith('INSERT INTO events(body)')) return statement;
    return { run(body) {
      if (JSON.parse(body).type === 'model-result') throw new Error('synthetic telemetry write failure');
      return statement.run(body);
    } };
  };
  try {
    const result = await runWorkbench({ directory: runPath, gateway: { next: async () => ({ text: 'Independent returned answer', calls: [], usage: { prompt_tokens: 1 } }) } });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Independent returned answer');
  } finally { DatabaseSync.prototype.prepare = prepare; }
  const report = await observation.observeRun(runPath);
  assert.equal(report.requests.recorded, 1);
  assert.equal(report.requests.returned, 1); // Existing assistant receipt still proves return.
  assert.equal(report.usage.promptTokens, 1); // Reuse its known usage, never count it twice.
  assert.equal(report.timeline.some(event => event.type === 'model-result'), false);
});

test('best-effort observations still cannot bypass cancellation fencing', async t => {
  const path = await directory(t);
  const store = await openRunStore(path);
  await store.claim();
  await store.cancel();
  assert.deepEqual(await store.recordObservation({ type: 'model-result', requestId: 'late' }), { recorded: false });
  await assert.rejects(store.record({ type: 'unauthorized-effect' }), /cancel/i);
  assert.deepEqual(store.events().map(event => event.type), ['cancelled']);
  await store.close();
});

test('evaluation exercises read-only HTTP report, source and attachment routes without claiming semantic quality', async t => {
  const path = await directory(t);
  await runWorkbench({ directory: path });
  const before = await readFile(join(path, 'run.sqlite'));
  const result = await evaluation.evaluateRun(path);
  assert.equal(result.execution.mode, 'fixture');
  assert.ok(result.checks.length >= 9);
  assert.ok(result.checks.every(check => check.status === 'passed'));
  assert.equal(result.checks.filter(check => check.kind === 'original-window').length, 4);
  assert.equal(result.checks.filter(check => check.kind === 'attachment-download').length, 4);
  assert.ok(result.checks.every(check => check.evidence.method === 'GET' && check.evidence.route.startsWith('/api/')));
  assert.ok(result.checks.filter(check => check.kind === 'attachment-download').every(check => check.evidence.bytes > 0 && /^[a-f0-9]{64}$/.test(check.evidence.sha256)));
  assert.equal(result.semantic.status, 'unreviewed');
  assert.equal(result.semantic.questions.length, 3);
  assert.equal(result.overallQuality, 'unreviewed');
  assert.equal(JSON.stringify(result).includes('两版手册比较'), false);
  assert.deepEqual(await readFile(join(path, 'run.sqlite')), before);
  const cliResult = await launch(['evaluate', '--state', path]);
  assert.equal(cliResult.code, 0, cliResult.stderr);
  assert.equal(JSON.parse(cliResult.stdout).semantic.status, 'unreviewed');
});

test('a missing registered blob fails its own download check while report and original windows remain readable', async t => {
  const path = await directory(t);
  await runWorkbench({ directory: path });
  const work = await openWorkbench(path);
  const saved = await work.publications.get('comparison');
  const { record } = await work.artifacts.get('report-md');
  await work.close();
  await rm(join(path, 'artifacts', 'blobs', `${record.sha256}.bin`));
  const result = await evaluation.evaluateRun(path);
  const failed = result.checks.filter(check => check.status === 'failed');
  assert.deepEqual(failed.map(check => [check.kind, check.id]), [['attachment-download', 'report-md']]);
  assert.ok(result.checks.filter(check => check.kind === 'report' || check.kind === 'original-window').every(check => check.status === 'passed'));
  const reopened = await openWorkbench(path);
  assert.deepEqual(await reopened.publications.get('comparison'), saved);
  await reopened.close();
});

test('an existing unfinished Run without a report is a measured delivery gap, not a successful case', async t => {
  const path = await directory(t);
  const work = await openWorkbench(path);
  await work.close();
  const result = await evaluation.evaluateRun(path);
  assert.ok(result.checks.some(check => check.kind === 'report-list' && check.status === 'not_available'));
  assert.equal(result.semantic.status, 'unreviewed');
});
