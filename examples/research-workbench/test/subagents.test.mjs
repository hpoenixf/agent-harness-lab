import test from 'node:test';
import assert from 'node:assert/strict';

import * as subagents from '../src/subagents.mjs';

test('SharedBudget keeps exhausted counters unchanged', () => {
  assert.equal(typeof subagents.SharedBudget, 'function');
  const budget = new subagents.SharedBudget({ modelRequests: 1, toolCalls: 2 });
  assert.equal(budget.consume('modelRequests'), true);
  assert.equal(budget.consume('modelRequests'), false);
  assert.deepEqual(budget.snapshot(), { modelRequests: { limit: 1, used: 1, remaining: 0 }, toolCalls: { limit: 2, used: 0, remaining: 2 } });
  assert.throws(() => budget.consume('unknown'), /budget kind/);
});

test('workers truly overlap within the concurrency bound and share budget contention', async () => {
  const budget = new subagents.SharedBudget({ modelRequests: 2, toolCalls: 1 });
  let active = 0;
  let peak = 0;
  let release;
  const bothStarted = new Promise(resolve => { release = resolve; });
  const results = await subagents.runSubagents({
    tasks: [{ id: 'slow', documentIds: ['a'], instruction: 'Read A' }, { id: 'fast', documentIds: ['b'], instruction: 'Read B' }],
    grant: { documentIds: ['a', 'b'] }, budget, concurrency: 2,
    worker: async (task, context) => {
      active++;
      peak = Math.max(peak, active);
      if (active === 2) release();
      await bothStarted;
      assert.equal(context.budget, budget);
      assert.equal(context.budget.consume('modelRequests'), true);
      const allowed = context.budget.consume('toolCalls');
      if (task.id === 'slow') await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      return { sourceIds: [`source:${task.documentIds[0]}`], output: { allowed } };
    },
  });
  assert.equal(peak, 2);
  assert.deepEqual(results.map(result => result.id), ['slow', 'fast']);
  assert.deepEqual(results.map(result => result.sourceIds), [['source:a'], ['source:b']]);
  assert.equal(results.filter(result => result.output.allowed).length, 1);
  assert.equal(budget.snapshot().modelRequests.used, 2);
});

test('out-of-grant and failed children remain local while successful siblings retain identity', async () => {
  const seen = [];
  const results = await subagents.runSubagents({
    tasks: [{ id: 'forbidden', documentIds: ['private'], instruction: 'Read' }, { id: 'broken', documentIds: ['a'], instruction: 'Read' }, { id: 'ok', documentIds: ['b'], instruction: 'Read' }],
    grant: { documentIds: ['a', 'b'] }, budget: new subagents.SharedBudget({ modelRequests: 3, toolCalls: 3 }), concurrency: 1,
    worker: async (task, context) => {
      seen.push(task.id);
      assert.deepEqual(context.grant.documentIds, task.documentIds);
      assert.equal(Object.isFrozen(context.grant.documentIds), true);
      if (task.id === 'broken') throw new Error('child interrupted');
      return { sourceIds: ['source:b'], output: 'B observation' };
    },
  });
  assert.deepEqual(seen, ['broken', 'ok']);
  assert.deepEqual(results.map(result => result.status), ['failed', 'failed', 'completed']);
  assert.equal(results[0].error.code, 'outside_grant');
  assert.equal(results[2].output, 'B observation');
});

test('duplicate task IDs and invalid observation receipts cannot become successful results', async () => {
  const budget = new subagents.SharedBudget({ modelRequests: 3, toolCalls: 3 });
  await assert.rejects(() => subagents.runSubagents({ tasks: [{ id: 'same', documentIds: [] }, { id: 'same', documentIds: [] }], grant: { documentIds: [] }, budget, worker: async () => ({ sourceIds: [] }) }), /duplicate task/);
  const results = await subagents.runSubagents({ tasks: [{ id: 'missing-sources', documentIds: [] }], grant: { documentIds: [] }, budget, worker: async () => ({ output: 'unbound' }) });
  assert.equal(results[0].status, 'failed');
  assert.equal(results[0].error.code, 'invalid_observation');
});
