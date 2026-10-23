import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readRunSnapshot } from './storage.mjs';
import { createReaderServer } from './server.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
async function json(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

// Existing persisted objects only. These read ports never mkdir, save, project a
// new publication, claim a lease or invoke a gateway. The normal reader routes
// serve them, so evaluation actually downloads bytes rather than checking paths.
async function readPorts(directory) {
  const state = await json(join(directory, 'publications', 'state.json')) ?? { publications: {} };
  const publications = {
    async list() { return Object.values(state.publications).map(entry => entry.revisions.at(-1)).sort((a, b) => a.id.localeCompare(b.id)); },
    async get(id, { revision } = {}) {
      const revisions = state.publications[digest(id)]?.revisions ?? [];
      return revision === undefined ? revisions.at(-1) : revisions.find(value => value.revision === revision);
    },
  };
  const sources = { async get(id) {
    return /^source-[a-f0-9]{64}$/.test(id) ? json(join(directory, 'sources', id + '.json')) : undefined;
  } };
  const artifacts = { async get(id) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(id) || id.includes('..')) return undefined;
    const record = await json(join(directory, 'artifacts', 'records', digest(id) + '.json'));
    if (!record) return undefined;
    if (!/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('Invalid registered digest');
    const bytes = await readFile(join(directory, 'artifacts', 'blobs', record.sha256 + '.bin'));
    if (digest(bytes) !== record.sha256 || bytes.length !== record.size) throw new Error('Registered bytes changed');
    return { record, bytes };
  } };
  return { publications, sources, artifacts };
}

/** Objective delivery checks are observations, never a publication or quality gate. */
export async function evaluateRun(directory) {
  const snapshot = await readRunSnapshot(directory); // Missing state cannot become a new successful Run.
  const ports = await readPorts(directory);
  const server = await createReaderServer(ports);
  const checks = [];
  async function get(route) {
    try {
      const response = await fetch(server.url + route);
      const bytes = Buffer.from(await response.arrayBuffer());
      return { response, bytes, evidence: { method: 'GET', route, httpStatus: response.status, bytes: bytes.length } };
    } catch { return { evidence: { method: 'GET', route, httpStatus: null, bytes: null } }; }
  }
  const parse = result => { try { return JSON.parse(result.bytes.toString('utf8')); } catch { return undefined; } };
  try {
    const listed = await get('/api/publications');
    const reports = parse(listed);
    const hasReports = listed.response?.status === 200 && Array.isArray(reports) && reports.length > 0;
    checks.push({ kind: 'report-list', status: hasReports ? 'passed' : listed.response?.status === 200 ? 'not_available' : 'failed', evidence: { ...listed.evidence, count: Array.isArray(reports) ? reports.length : null } });
    for (const report of hasReports ? reports : []) {
      const route = `/api/publications/${encodeURIComponent(report.id)}?revision=${report.revision}`;
      const loaded = await get(route), actual = parse(loaded);
      const passed = loaded.response?.status === 200 && actual?.id === report.id && actual.revision === report.revision && actual.status === 'committed' && typeof actual.body === 'string' && actual.body === report.body;
      checks.push({ kind: 'report', id: report.id, status: passed ? 'passed' : 'failed', evidence: { ...loaded.evidence, revision: report.revision, bodyChars: typeof actual?.body === 'string' ? actual.body.length : null } });
      if (!(report.citations?.length)) checks.push({ kind: 'original-window-list', id: report.id, status: 'not_available', evidence: { ...loaded.evidence, count: 0 } });
      for (const citation of report.citations ?? []) {
        const expected = citation.source;
        const sourceId = expected?.id ?? citation.sourceId;
        const loaded = await get(`/api/sources/${encodeURIComponent(sourceId)}`), source = parse(loaded);
        const sha256 = typeof source?.text === 'string' ? digest(source.text) : null;
        const passed = loaded.response?.status === 200 && expected && source.id === expected.id && source.documentId === expected.documentId && source.version === expected.version && source.page === expected.page && sha256 === expected.hash;
        checks.push({ kind: 'original-window', id: sourceId, status: passed ? 'passed' : 'failed', evidence: { ...loaded.evidence, citation: citation.number, sha256, documentId: source?.documentId ?? null, version: source?.version ?? null, page: source?.page ?? null } });
      }
      if (!(report.attachments?.length)) checks.push({ kind: 'attachment-list', id: report.id, status: 'not_available', evidence: { ...loaded.evidence, count: 0 } });
      for (const attachment of report.attachments ?? []) {
        const expected = attachment.artifact;
        const id = expected?.id ?? attachment.artifactId;
        const loaded = await get(`/api/artifacts/${encodeURIComponent(id)}`);
        const sha256 = loaded.bytes ? digest(loaded.bytes) : null;
        const passed = loaded.response?.status === 200 && expected && sha256 === expected.sha256 && loaded.bytes.length === expected.size;
        checks.push({ kind: 'attachment-download', id, status: passed ? 'passed' : 'failed', evidence: { ...loaded.evidence, sha256, registeredSha256: expected?.sha256 ?? null, registeredBytes: expected?.size ?? null } });
      }
    }
  } finally { await server.close(); }
  return {
    runId: snapshot.run.id, snapshotSeq: snapshot.events.at(-1)?.seq ?? 0, evaluatedAt: new Date().toISOString(),
    execution: { mode: snapshot.run.gatewayMode ?? 'unknown', note: 'Local HTTP checks of existing durable files, not an atomic snapshot across routes. No new model call, comparison case or semantic review was performed.' },
    checks,
    semantic: { status: 'unreviewed', questions: [
      '逐项对照原窗口：正文结论是否得到原文支持，而不是仅有可打开的引用？',
      '版本、页范围、套餐及离线条件等关键限定是否保留，是否存在反例？',
      '正文与计算是否回答了用户问题；未取得的材料是否被如实说明？',
    ] },
    overallQuality: 'unreviewed',
  };
}
