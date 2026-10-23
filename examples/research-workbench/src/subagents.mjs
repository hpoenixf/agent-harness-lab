/** Synchronous consumption is atomic between async workers in this one process. */
export class SharedBudget {
  #limits;
  #used = { modelRequests: 0, toolCalls: 0 };

  constructor({ modelRequests, toolCalls }) {
    if (![modelRequests, toolCalls].every(value => Number.isSafeInteger(value) && value >= 0)) throw new TypeError('Budget limits must be nonnegative safe integers');
    this.#limits = { modelRequests, toolCalls };
  }

  consume(kind) {
    if (!Object.hasOwn(this.#limits, kind)) throw new TypeError(`Unknown budget kind: ${kind}`);
    if (this.#used[kind] >= this.#limits[kind]) return false;
    this.#used[kind]++;
    return true;
  }

  snapshot() {
    return Object.fromEntries(Object.keys(this.#limits).map(kind => [kind, { limit: this.#limits[kind], used: this.#used[kind], remaining: this.#limits[kind] - this.#used[kind] }]));
  }
}

/**
 * Root-owned read ports enforce document access; this scheduler narrows each
 * child's grant and supplies no publication port. sourceIds are opaque source
 * receipts returned by those ports, not aliases for document IDs.
 */
export async function runSubagents({ tasks, grant, budget, worker, concurrency = 2 }) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be a positive safe integer');
  if (!Array.isArray(tasks) || !Array.isArray(grant?.documentIds) || typeof worker !== 'function' || !(budget instanceof SharedBudget)) throw new TypeError('Expected tasks, document grant, shared budget and worker');
  const ids = new Set();
  for (const task of tasks) {
    if (typeof task.id !== 'string' || !Array.isArray(task.documentIds) || !task.documentIds.every(id => typeof id === 'string')) throw new TypeError('Tasks require string IDs and documentIds');
    if (ids.has(task.id)) throw new Error(`duplicate task ID: ${task.id}`);
    ids.add(task.id);
  }
  const allowed = new Set(grant.documentIds);
  const results = new Array(tasks.length);
  let next = 0;
  async function runWorker() {
    while (next < tasks.length) {
      const index = next++;
      const task = Object.freeze({ ...tasks[index], documentIds: Object.freeze([...tasks[index].documentIds]) });
      const base = { id: task.id, documentIds: [...task.documentIds], sourceIds: [] };
      if (task.documentIds.some(id => !allowed.has(id))) {
        results[index] = { ...base, status: 'failed', error: { code: 'outside_grant', message: 'Task requests documents outside the original grant' } };
        continue;
      }
      try {
        const childGrant = Object.freeze({ documentIds: Object.freeze([...task.documentIds]) });
        const observation = await worker(task, Object.freeze({ grant: childGrant, budget }));
        if (!observation || !Array.isArray(observation.sourceIds) || !observation.sourceIds.every(id => typeof id === 'string')) {
          results[index] = { ...base, status: 'failed', error: { code: 'invalid_observation', message: 'Worker must return an observation with sourceIds' } };
        } else {
          results[index] = { ...base, status: 'completed', sourceIds: [...observation.sourceIds], output: observation.output };
        }
      } catch (error) {
        results[index] = { ...base, status: 'failed', error: { code: 'worker_failed', message: error instanceof Error ? error.message : String(error) } };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, runWorker));
  return results;
}
