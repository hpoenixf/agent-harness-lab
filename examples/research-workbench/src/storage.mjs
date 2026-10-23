import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const effectContext = new AsyncLocalStorage();

// Inspection never initializes, migrates, claims or cancels a Run.
export async function readRunSnapshot(directory) {
  let db;
  try {
    db = new DatabaseSync(join(directory, 'run.sqlite'), { readOnly: true });
    db.exec('BEGIN');
    const row = db.prepare('SELECT body FROM run WHERE id=1').get();
    if (!row) throw new Error('Missing Run');
    const run = JSON.parse(row.body);
    const events = db.prepare('SELECT seq,body FROM events ORDER BY seq').all().map(row => ({ ...JSON.parse(row.body), seq: row.seq }));
    db.exec('COMMIT');
    return { run, events };
  } catch { throw new Error('Unable to read existing Run state'); }
  finally { db?.close(); }
}

// SQLite owns execution facts and fencing. Material files remain separately identified effects.
export async function openRunStore(directory, initial = {}, { leaseMs = 10_000 } = {}) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('Lease duration must be a positive integer');
  await mkdir(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'run.sqlite'));
  db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec(`CREATE TABLE IF NOT EXISTS run(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, epoch INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  const proposed = { id: randomUUID(), task: '比较两版手册的导出格式和上限，并记住以后先列限制。',
    initialMessageId: 'user-task', grant: { documentIds: ['manual-a-v1', 'manual-b-v2'] },
    budget: { modelRequests: 24, toolCalls: 80 }, ...initial };
  db.prepare('INSERT OR IGNORE INTO run(id,body) VALUES(1,?)').run(JSON.stringify(proposed));
  // Cold opens inherit this record; caller options and returned objects cannot edit its Grant.
  const run = freeze(JSON.parse(db.prepare('SELECT body FROM run WHERE id=1').get().body));
  const owner = randomUUID();
  let epoch, timer, closed = false, closing = false, closePromise, serial = Promise.resolve();
  const events = () => db.prepare('SELECT seq,body FROM events ORDER BY seq').all().map(row => ({ ...JSON.parse(row.body), seq: row.seq }));
  const cancelled = () => events().some(event => event.type === 'cancelled');
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function assertNotNested() {
    if (effectContext.getStore()?.active) throw new Error('Nested effects are not supported; record outside the effect callback');
  }
  function enqueue(fn) {
    assertNotNested();
    if (closed || closing) throw new Error('Run store is closed');
    const work = serial.then(fn);
    serial = work.catch(() => {});
    return work;
  }
  function currentLease() { return db.prepare('SELECT owner,epoch,expires FROM lease WHERE id=1').get(); }
  function assertOwned() {
    if (cancelled()) throw new Error('Run is cancelled');
    const lease = currentLease();
    if (!lease || lease.owner !== owner || lease.epoch !== epoch || lease.expires <= Date.now()) throw new Error('Execution lease is no longer owned');
  }
  function append(event) {
    const recorded = { ...event, recordedAt: new Date().toISOString() };
    const result = db.prepare('INSERT INTO events(body) VALUES(?)').run(JSON.stringify(recorded));
    return { ...recorded, seq: Number(result.lastInsertRowid) };
  }
  async function effect(fn) {
    return enqueue(async () => {
      // Short local effects only: the write lock orders them with takeover/cancel.
      // Do not perform network waits or call another store mutation inside fn.
      db.exec('BEGIN IMMEDIATE');
      const scope = { active: true };
      try {
        assertOwned();
        const result = await effectContext.run(scope, fn);
        db.exec('COMMIT');
        return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      finally { scope.active = false; }
    });
  }
  async function claim({ heartbeat = true } = {}) {
    const next = await enqueue(() => transaction(() => {
      if (cancelled()) throw new Error('Run is cancelled');
      const prior = currentLease();
      if (prior && prior.expires > Date.now()) throw new Error('Run already has an active worker');
      const nextEpoch = (prior?.epoch ?? 0) + 1;
      db.prepare('INSERT INTO lease(id,owner,epoch,expires) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,epoch=excluded.epoch,expires=excluded.expires')
        .run(owner, nextEpoch, Date.now() + leaseMs);
      return nextEpoch;
    }));
    epoch = next;
    clearInterval(timer);
    if (heartbeat && !closing) {
      timer = setInterval(() => { effect(() => {
        db.prepare('UPDATE lease SET expires=? WHERE id=1 AND owner=? AND epoch=?').run(Date.now() + leaseMs, owner, epoch);
      }).catch(() => { clearInterval(timer); }); }, Math.max(10, Math.floor(leaseMs / 3)));
      timer.unref();
    }
    return { owner, epoch };
  }
  const record = event => effect(() => append(event));
  async function recordObservation(event) {
    try { await record(event); return { recorded: true }; }
    catch { return { recorded: false }; }
  }
  async function cancel() {
    return enqueue(() => transaction(() => {
      const previous = events().find(event => event.type === 'cancelled');
      if (previous) return previous;
      const event = append({ type: 'cancelled' });
      db.prepare('UPDATE lease SET epoch=epoch+1,expires=0 WHERE id=1').run();
      return event;
    }));
  }
  async function close() {
    assertNotNested();
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(timer);
    closePromise = serial.then(() => {
      try {
        if (epoch !== undefined) transaction(() => db.prepare('UPDATE lease SET expires=0 WHERE id=1 AND owner=? AND epoch=?').run(owner, epoch));
      } finally { closed = true; db.close(); }
    });
    return closePromise;
  }
  return { run, events, claim, record, recordObservation, effect, cancel, close, cancelled,
    fence: () => ({ owner, epoch }) };
}
