import test from 'node:test';
import assert from 'node:assert/strict';

import * as extensions from '../src/extensions.mjs';
import * as skills from '../src/skills.mjs';
const schema = { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'], additionalProperties: false };

test('registry rejects unknown and invalid calls without dispatching a handler', async () => {
  assert.equal(typeof extensions.createToolRegistry, 'function');
  const registry = extensions.createToolRegistry();
  let calls = 0;
  registry.register('search', { description: 'Search supplied notes', inputSchema: schema, execute: async args => { calls++; return args.query; } });
  assert.deepEqual(registry.descriptions(), [{ name: 'search', description: 'Search supplied notes', inputSchema: schema }]);
  for (const call of [{ id: 'unknown', name: 'missing', args: {} }, { id: 'invalid', name: 'search', args: { query: 7 } }]) {
    const receipt = await registry.dispatch(call, {});
    assert.equal(receipt.id, call.id);
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.dispatched, false);
  }
  assert.equal(calls, 0);
  const receipt = await registry.dispatch({ id: 'ok', name: 'search', args: { query: 'export' } }, {});
  assert.equal(receipt.output, 'export');
  assert.equal(receipt.dispatched, true);
});

test('handler failure records that dispatch occurred', async () => {
  const registry = extensions.createToolRegistry();
  registry.register('read', { description: 'Read note', inputSchema: { type: 'object' }, execute() { throw new Error('read interrupted'); } });
  const receipt = await registry.dispatch({ id: 'c1', name: 'read', args: {} });
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.dispatched, true);
  assert.match(receipt.error.message, /read interrupted/);
});

test('captured generation remains callable and is disposed only after its last release', async () => {
  const registry = extensions.createToolRegistry();
  const host = extensions.createExtensionHost({ registry });
  const disposed = [];
  const contribution = version => ({ tools: [{ name: 'version', description: 'Show version', inputSchema: { type: 'object' }, execute: () => version }], skills: [{ name: version }], dispose: () => disposed.push(version) });
  assert.equal((await host.activate({ name: 'demo', version: 'one', contribute: () => contribution('one') })).status, 'active');
  const old = host.acquire();
  const old2 = host.acquire();
  await host.activate({ name: 'demo', version: 'two', contribute: () => contribution('two') });
  assert.equal((await old.dispatch({ id: 'old', name: 'version', args: {} })).output, 'one');
  assert.equal((await host.dispatch({ id: 'new', name: 'version', args: {} })).output, 'two');
  assert.deepEqual(disposed, []);
  await old.release();
  await old.release();
  assert.deepEqual(disposed, []);
  await old2.release();
  assert.deepEqual(disposed, ['one']);
  await host.dispose();
  assert.deepEqual(disposed, ['one', 'two']);
});

test('failed replacement leaves the entire previous generation active', async () => {
  const host = extensions.createExtensionHost({ registry: extensions.createToolRegistry() });
  await host.activate({ name: 'demo', version: 'one', contribute: () => ({ tools: [{ name: 'read', description: 'Original', inputSchema: { type: 'object' }, execute: () => 'original' }] }) });
  let cleaned = 0;
  const result = await host.activate({ name: 'demo', version: 'bad', contribute: () => ({ tools: [
    { name: 'other', description: 'Partial', inputSchema: { type: 'object' }, execute: () => 'partial' },
    { name: 'other', description: 'Duplicate', inputSchema: { type: 'object' }, execute: () => 'duplicate' },
  ], dispose: () => cleaned++ }) });
  assert.equal(result.status, 'failed');
  assert.equal(cleaned, 1);
  assert.deepEqual(host.descriptions().map(tool => tool.name), ['read']);
  assert.equal((await host.dispatch({ id: 'kept', name: 'read', args: {} })).output, 'original');
  await host.dispose();
});

test('hooks retain call identity and order, normalize arguments, and keep after failures local', async () => {
  const registry = extensions.createToolRegistry();
  registry.register('search', { description: 'Search notes', inputSchema: schema, execute: args => args.query });
  const host = extensions.createExtensionHost({ registry });
  const seen = [];
  await host.activate({ name: 'hooks', version: '1', contribute: () => ({ hooks: [
    { id: 'trim', before: call => { seen.push(['trim', call.id]); return { args: { query: call.args.query.trim() } }; }, after: receipt => { seen.push(['first-after', receipt.id]); throw new Error('observer unavailable'); } },
    { id: 'observe', before: call => { seen.push(['second-before', call.id]); }, after: receipt => { seen.push(['second-after', receipt.id]); } },
  ] }) });
  const receipt = await host.dispatch({ id: 'call-7', name: 'search', args: { query: ' export ' } });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.output, 'export');
  assert.deepEqual(receipt.args, { query: 'export' });
  assert.deepEqual(receipt.originalArgs, { query: ' export ' });
  assert.deepEqual(seen, [['trim', 'call-7'], ['second-before', 'call-7'], ['first-after', 'call-7'], ['second-after', 'call-7']]);
  assert.equal(receipt.observations[0].hookId, 'trim');
  await host.dispose();
});

test('before-hook failure prevents only that tool call', async () => {
  const registry = extensions.createToolRegistry();
  let dispatched = 0;
  registry.register('read', { description: 'Read note', inputSchema: { type: 'object' }, execute: () => ++dispatched });
  const host = extensions.createExtensionHost({ registry });
  await host.activate({ name: 'local', version: '1', contribute: () => ({ hooks: [{ id: 'local-check', before: call => { if (call.id === 'blocked') throw new Error('local read unavailable'); } }] }) });
  assert.equal((await host.dispatch({ id: 'blocked', name: 'read', args: {} })).dispatched, false);
  assert.equal((await host.dispatch({ id: 'allowed', name: 'read', args: {} })).output, 1);
  assert.equal(dispatched, 1);
  await host.dispose();
});

test('retired generation cleanup failure cannot replace an in-flight tool receipt', async () => {
  const host = extensions.createExtensionHost({ registry: extensions.createToolRegistry() });
  let started;
  const didStart = new Promise(resolve => { started = resolve; });
  let finish;
  const canFinish = new Promise(resolve => { finish = resolve; });
  await host.activate({ name: 'demo', version: 'one', contribute: () => ({
    tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object' }, execute: async () => { started(); await canFinish; return 'body'; } }],
    dispose: () => { throw new Error('cleanup unavailable'); },
  }) });
  const pending = host.dispatch({ id: 'in-flight', name: 'read', args: {} });
  await didStart;
  await host.activate({ name: 'demo', version: 'two', contribute: () => ({}) });
  finish();
  const receipt = await pending;
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.output, 'body');
  assert.equal(receipt.observations.at(-1).code, 'cleanup_failed');
  await host.dispose();
});

test('Skill pages reconstruct supplied content and cursors are bound to its hash', async () => {
  assert.equal(typeof skills.createSkillCatalog, 'function');
  const entry = { resourceId: 'skill:compare', name: 'compare', description: 'Compare supplied evidence', content: 'Read both.\nCompare claims.\nState gaps.' };
  const catalog = await skills.createSkillCatalog([entry]);
  const descriptor = catalog.list()[0];
  assert.equal(descriptor.resourceId, entry.resourceId);
  assert.equal(descriptor.content, undefined);
  const first = await catalog.read({ resourceId: entry.resourceId, maxChars: 10 });
  const second = await catalog.read({ resourceId: entry.resourceId, cursor: first.nextCursor, maxChars: 100 });
  assert.equal(first.text + second.text, entry.content);
  assert.equal(first.coverage, 'partial');
  assert.equal(second.coverage, 'complete');
  assert.equal(second.nextCursor, undefined);
  const revised = await skills.createSkillCatalog([{ ...entry, content: `${entry.content}!` }]);
  const stale = await revised.read({ resourceId: entry.resourceId, cursor: first.nextCursor });
  assert.equal(stale.status, 'failed');
  assert.equal(stale.error.code, 'invalid_cursor');
  assert.equal((await catalog.read({ resourceId: 'skill:missing' })).status, 'failed');
});
