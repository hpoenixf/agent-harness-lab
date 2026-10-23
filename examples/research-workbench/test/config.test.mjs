import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { openWorkbench } from '../src/workbench.mjs';

import * as config from '../src/config.mjs';
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const configModulePath = fileURLToPath(new URL('../src/config.mjs', import.meta.url));
const cleanEnv = extra => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HARNESS_'))), ...extra });
const launch = (args, { cwd, env = cleanEnv() } = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', code => resolve({ code, stdout, stderr }));
});

test('default configuration is anchored to the example module rather than the working directory', async t => {
  assert.equal(typeof config.loadConfig, 'function');
  const root = await mkdtemp(join(tmpdir(), 'workbench-config-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const example = join(root, 'nested-example');
  await mkdir(join(example, 'src'), { recursive: true });
  await writeFile(join(root, '.env'), 'HARNESS_MODEL=wrong-parent-model\nHARNESS_API_KEY=wrong-parent-key\n');
  await writeFile(join(example, '.env'), 'HARNESS_BASE_URL=http://127.0.0.1:1234/v1\nHARNESS_MODEL=example-model\nHARNESS_API_KEY=\n');
  await writeFile(join(example, 'src/config.mjs'), await readFile(configModulePath));
  const isolated = await import(pathToFileURL(join(example, 'src/config.mjs')));
  assert.equal(isolated.DEFAULT_CONFIG_PATH, await realpath(join(example, '.env')));
  assert.deepEqual(await isolated.loadConfig({ env: {} }), { baseUrl: 'http://127.0.0.1:1234/v1', model: 'example-model', apiKey: '' });
  await rm(join(example, '.env'));
  assert.deepEqual(await isolated.loadConfig({ env: {} }), { baseUrl: '', model: '', apiKey: '' });
});

test('explicit configuration uses dotenv quoting and existing environment values take precedence including empty Key', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-config-values-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'custom.env');
  await writeFile(path, '# synthetic configuration\nHARNESS_BASE_URL="http://127.0.0.1:4321/v1"\nHARNESS_MODEL=file-model\nHARNESS_API_KEY="synthetic # key"\nUNRELATED_SETTING=ignored\n');
  const env = { HARNESS_MODEL: 'environment-model', HARNESS_API_KEY: '' };
  assert.deepEqual(await config.loadConfig({ configPath: path, env }), { baseUrl: 'http://127.0.0.1:4321/v1', model: 'environment-model', apiKey: '' });
  assert.deepEqual(env, { HARNESS_MODEL: 'environment-model', HARNESS_API_KEY: '' });
  assert.equal((await config.loadConfig({ configPath: path, env: {} })).apiKey, 'synthetic # key');
  await assert.rejects(() => config.loadConfig({ configPath: join(root, 'missing.env'), env: {} }), /configuration file/i);
});

test('configure creates a private template once and never prints or overwrites existing values', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-configure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'my configuration.env');
  const first = await launch(['configure', '--config', path], { cwd: root });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, 'created');
  const template = await readFile(path, 'utf8');
  assert.match(template, /HARNESS_BASE_URL=/);
  assert.match(template, /HARNESS_MODEL=/);
  assert.match(template, /HARNESS_API_KEY=/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const existing = 'HARNESS_API_KEY=synthetic-secret-that-must-stay-private\n';
  await writeFile(path, existing);
  const second = await launch(['configure', '--config', path, '--live'], { cwd: root });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, 'exists');
  assert.equal(await readFile(path, 'utf8'), existing);
  assert.equal((first.stdout + first.stderr + second.stdout + second.stderr).includes('synthetic-secret-that-must-stay-private'), false);
});

test('offline demo remains Key-free and does not require or load a requested model configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-config-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await launch(['demo', '--config', join(root, 'absent.env'), '--state', join(root, 'state')], { cwd: root });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'completed');
});

test('live background inherits private configuration and a local Key-free foreground request also works', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-config-background-'));
  const state = join(root, 'state');
  const path = join(root, 'worker configuration.env');
  const requests = [];
  let work;
  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    requests.push({ path: incoming.url, authorization: incoming.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
    outgoing.end('data: {"choices":[{"index":0,"delta":{"content":"Local configuration reached."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await writeFile(path, `HARNESS_BASE_URL=http://127.0.0.1:${server.address().port}/v1\nHARNESS_MODEL=file-model\nHARNESS_API_KEY=synthetic-background-secret\n`);
    const started = await launch(['background', '--live', '--config', 'worker configuration.env', '--state', state], { cwd: root, env: cleanEnv({ HARNESS_MODEL: 'environment-model' }) });
    assert.equal(started.code, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).status, 'started');
    let complete = false;
    for (let attempt = 0; attempt < 100 && !complete; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      // Opening a Run before the child initializes it would itself create a
      // fixture Run. Observe the worker log until the owner finishes instead.
      complete = (await readFile(join(state, 'worker.log'), 'utf8')).includes('"status": "completed"');
    }
    assert.equal(complete, true, await readFile(join(state, 'worker.log'), 'utf8'));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/v1/chat/completions');
    assert.equal(requests[0].authorization, 'Bearer synthetic-background-secret');
    assert.equal(requests[0].body.model, 'environment-model');
    work = await openWorkbench(state);
    const persisted = JSON.stringify({ run: work.store.run, events: work.store.events(), publications: await work.publications.list() });
    assert.equal(persisted.includes('synthetic-background-secret'), false);
    assert.equal((started.stdout + started.stderr + await readFile(join(state, 'worker.log'), 'utf8')).includes('synthetic-background-secret'), false);
    const keyless = await launch(['demo', '--live', '--config', path, '--state', join(root, 'keyless-state')], { cwd: root, env: cleanEnv({ HARNESS_API_KEY: '' }) });
    assert.equal(keyless.code, 0, keyless.stderr);
    assert.equal(JSON.parse(keyless.stdout).status, 'completed');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].authorization, undefined);
    assert.equal(requests[1].body.model, 'file-model');
  } finally {
    await work?.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  }
});
