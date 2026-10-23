import { readRunSnapshot } from './storage.mjs';

const nonnegative = value => Number.isFinite(value) && value >= 0;
export function usageMetadata(usage) {
  const fields = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
  const entries = fields.filter(key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0).map(key => [key, usage[key]]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** A projection of recorded facts, never task coverage or model quality. */
export function summarizeObservation({ run, events }) {
  const requests = events.filter(event => event.type === 'model-request');
  const responses = requests.map(request => events.find(event => event.type === 'model-result' && request.requestId && event.requestId === request.requestId)
    ?? events.find(event => event.type === 'assistant' && request.turnId && event.turnId === request.turnId));
  const usages = responses.map(event => usageMetadata(event?.usage));
  const tokenTotal = field => requests.length && usages.every(usage => nonnegative(usage?.[field])) ? usages.reduce((sum, usage) => sum + usage[field], 0) : null;
  const durations = responses.map(event => event?.durationMs);
  const starts = events.filter(event => event.type === 'tool-start');
  const receipts = events.filter(event => event.type === 'tool-result');
  const mode = run.gatewayMode ?? 'unknown';
  return {
    runId: run.id,
    execution: { mode, modelQualityEvidence: false, note: mode === 'fixture' ? 'Scripted synthetic execution; no real model was evaluated.' : 'A configured gateway mode alone does not establish model quality or billing.' },
    state: events.some(event => event.type === 'completed') ? 'completed' : events.some(event => event.type === 'cancelled') ? 'cancelled' : 'not_completed',
    requests: { recorded: requests.length, summary: requests.filter(event => event.kind === 'summary').length,
      returned: responses.filter(event => event && event.status !== 'failed').length,
      failed: responses.filter(event => event?.status === 'failed').length,
      responseUnknown: responses.filter(event => !event).length,
      durationUnknown: durations.filter(value => !nonnegative(value)).length,
      durationMs: requests.length && durations.every(nonnegative) ? durations.reduce((sum, value) => sum + value, 0) : null },
    tools: { admitted: starts.length, dispatched: receipts.filter(event => event.receipt?.dispatched === true).length,
      notDispatched: receipts.filter(event => event.receipt?.dispatched === false).length,
      dispatchUnknown: starts.filter(start => !receipts.some(event => event.callId === start.callId)).length,
      note: 'Counts describe recorded receipts; an interrupted attempt without a receipt remains unknown.' },
    usage: { knownRequests: usages.filter(usage => nonnegative(usage?.prompt_tokens) && nonnegative(usage?.completion_tokens)).length,
      unknownRequests: usages.filter(usage => !nonnegative(usage?.prompt_tokens) || !nonnegative(usage?.completion_tokens)).length,
      promptTokens: tokenTotal('prompt_tokens'), completionTokens: tokenTotal('completion_tokens'), totalTokens: tokenTotal('total_tokens') },
    cost: { status: 'unknown', amount: null, currency: null, reason: 'No billing receipt or price basis is recorded.' },
    timeline: events.map(event => {
      const item = { seq: event.seq, type: event.type,
        recordedAt: Number.isFinite(Date.parse(event.recordedAt)) ? event.recordedAt : null,
        durationMs: nonnegative(event.durationMs) ? event.durationMs : null };
      for (const key of ['requestId', 'turnId', 'kind', 'callId', 'scope', 'name', 'generation']) if (event[key] !== undefined) item[key] = event[key];
      if (event.type === 'model-result') item.status = event.status;
      if (event.type === 'tool-result') { item.status = event.result?.status ?? 'unknown'; item.dispatched = event.receipt?.dispatched ?? null; }
      return item;
    }),
  };
}

export async function observeRun(directory) {
  return summarizeObservation(await readRunSnapshot(directory));
}
