import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openRunStore } from '../src/storage.mjs';

if (process.argv[2] === 'storage-child') {
  const directory = process.argv[3];
  const options = JSON.parse(process.argv[4]);
  const store = await openRunStore(directory, options.initial, { leaseMs: options.leaseMs ?? 2000 });
  let lease, claimError;
  try { if (options.claim) lease = await store.claim({ heartbeat: false }); }
  catch (error) { claimError = error.message; }
  process.on('message', async ({ id, action, value }) => {
    try {
      let result;
      if (action === 'snapshot') {
        let mutationRejected = false;
        try { store.run.grant.documentIds.push('not-in-original-grant'); }
        catch { mutationRejected = true; }
        result = { run: store.run, events: store.events(), mutationRejected };
      } else if (action === 'record') result = await store.record(value);
      else if (action === 'write') result = await store.effect(() => writeFile(join(directory, 'material.txt'), value));
      else if (action === 'cancel') result = await store.cancel();
      else if (action === 'nested') result = await store.effect(() => store.record({ type: 'nested' }));
      else if (action === 'close') await store.close();
      else throw new Error('Unknown test command');
      process.send({ id, result }, () => { if (action === 'close') process.disconnect(); });
    } catch (error) { process.send({ id, error: error.message }); }
  });
  process.send({ ready: true, run: store.run, lease, claimError });
} else {
  async function workspace(t) {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-storage-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
  }
  async function worker(t, directory, options = {}) {
    const child = fork(fileURLToPath(import.meta.url), ['storage-child', directory, JSON.stringify(options)], {
      execPath: process.execPath, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let sequence = 0, diagnostics = '';
    const pending = new Map();
    child.stderr.on('data', bytes => { diagnostics += bytes; });
    const exited = new Promise(resolve => child.once('exit', resolve));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    });
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Child startup timed out: ' + diagnostics)), 3000);
      child.on('message', message => {
        if (message.ready) { clearTimeout(timeout); resolve(message); return; }
        pending.get(message.id)?.(message);
      });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Child exited: ' + diagnostics)); });
    });
    return { ready, async request(action, value, timeoutMs = 2000) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Child command timed out')); }, timeoutMs);
        pending.set(id, message => {
          clearTimeout(timeout); pending.delete(id);
          if (message.error) reject(new Error(message.error)); else resolve(message.result);
        });
        child.send({ id, action, value });
      });
    } };
  }

  test('a cold process keeps the original grant and durable event sequence', async t => {
    const directory = await workspace(t);
    const store = await openRunStore(directory, { grant: { documentIds: ['manual-a-v1'] } });
    await store.claim({ heartbeat: false });
    const first = await store.record({ type: 'page-read', sourceId: 'A-v1-p2', seq: 999 });
    await store.record({ type: 'published', blockId: 'body-1' });
    await store.close();
    const cold = await worker(t, directory, { initial: { grant: { documentIds: ['manual-b-v2'] } } });
    assert.deepEqual(cold.ready.run.grant.documentIds, ['manual-a-v1']);
    const snapshot = await cold.request('snapshot');
    assert.equal(snapshot.mutationRejected, true);
    assert.deepEqual(snapshot.run.grant.documentIds, ['manual-a-v1']);
    assert.deepEqual(snapshot.events.map(event => event.seq), [1, 2]);
    assert.equal(first.seq, 1);
    await cold.request('close');
  });

  test('a second process cannot claim while the original owner is active', async t => {
    const directory = await workspace(t);
    const first = await worker(t, directory, { claim: true });
    assert(first.ready.lease);
    const second = await worker(t, directory, { claim: true });
    assert.match(second.ready.claimError, /active worker/i);
    await assert.rejects(second.request('write', 'foreign'), /lease/i);
    await first.request('write', 'owner');
    assert.equal(await readFile(join(directory, 'material.txt'), 'utf8'), 'owner');
    await second.request('close');
    await first.request('close');
  });

  test('expired takeover fences the old process before its late durable effect', async t => {
    const directory = await workspace(t);
    const old = await worker(t, directory, { claim: true, leaseMs: 80 });
    await delay(140);
    const current = await worker(t, directory, { claim: true });
    assert(current.ready.lease.epoch > old.ready.lease.epoch);
    await current.request('write', 'new owner');
    await assert.rejects(old.request('write', 'late old owner'), /lease/i);
    await assert.rejects(old.request('record', { type: 'late' }), /lease/i);
    await old.request('close');
    await current.request('record', { type: 'current-owner' });
    assert.equal(await readFile(join(directory, 'material.txt'), 'utf8'), 'new owner');
    const snapshot = await current.request('snapshot');
    assert.deepEqual(snapshot.events.map(event => event.type), ['current-owner']);
    await current.request('close');
  });

  test('durable cancellation blocks the current owner and cannot revive through a new claim', async t => {
    const directory = await workspace(t);
    const owner = await worker(t, directory, { claim: true });
    await owner.request('write', 'before cancellation');
    const controller = await worker(t, directory);
    const cancelled = await controller.request('cancel');
    await assert.rejects(owner.request('write', 'after cancellation'), /cancel|lease/i);
    assert.deepEqual(await controller.request('cancel'), cancelled);
    await assert.rejects(owner.request('record', { type: 'after-cancel' }), /cancel|lease/i);
    const cold = await worker(t, directory, { claim: true });
    assert.match(cold.ready.claimError, /cancel/i);
    assert.equal(await readFile(join(directory, 'material.txt'), 'utf8'), 'before cancellation');
    const snapshot = await cold.request('snapshot');
    assert.deepEqual(snapshot.events.map(event => event.type), ['cancelled']);
    await cold.request('close'); await controller.request('close'); await owner.request('close');
  });

  test('nested effects are rejected promptly instead of waiting on their own queue', async t => {
    const directory = await workspace(t);
    const owner = await worker(t, directory, { claim: true });
    await assert.rejects(owner.request('nested', undefined, 200), /nested/i);
    await owner.request('record', { type: 'continued-after-nested-rejection' });
    await owner.request('close');
  });
}
