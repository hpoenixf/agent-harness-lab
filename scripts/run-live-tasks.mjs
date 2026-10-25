#!/usr/bin/env node
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChatGateway } from '../examples/research-workbench/src/gateway.mjs';
import { runWorkbench } from '../examples/research-workbench/src/workbench.mjs';
import { readRunSnapshot } from '../examples/research-workbench/src/storage.mjs';
import { evaluateRun } from '../examples/research-workbench/src/evaluation.mjs';

export const LIVE_TASKS = Object.freeze([
  {
    id: 'export-history',
    prompt: "请比较 A 1.0 和 B 2.0 的导出能力。我想知道可导出格式，以及导出文件是否保留操作历史。请说明依据的文档，并保存一份我稍后可以打开的报告和可下载附件。",
  },
  {
    id: 'free-offline-editing',
    prompt: "对比 A 1.0 和 B 2.0，免费版在离线状态能不能编辑？如果只能查看或需要联网，请说清楚各版本条件，附上出处并保存可下载报告，方便我稍后打开。",
  },
  {
    id: 'export-limit-change',
    prompt: "导出数量限制从 A 1.0 到 B 2.0 怎么变？请算每次最多导出条数增加了多少、相对原来是几倍。说明依据并保存报告和附件供我稍后打开。",
  },
  {
    id: 'cited-downloadable-report',
    prompt: "我想稍后复查 A 1.0 和 B 2.0 的差异。请制作一份有出处的对比报告，列出关键差异，并提供我能实际下载和稍后打开的附件。",
  },
]);

function safe(value, secret) {
  if (typeof value === 'string') return secret ? value.split(secret).join('[REDACTED]') : value;
  if (Array.isArray(value)) return value.map(item => safe(item, secret));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safe(item, secret)]));
  return value;
}

function summarizeProviderErrorBody(body) {
  let providerErrorType = null, providerErrorCode = null;
  try {
    const value = JSON.parse(body);
    providerErrorType = typeof value.error?.type === 'string' ? value.error.type : null;
    providerErrorCode = typeof value.error?.code === 'string' ? value.error.code : null;
  } catch { /* response text is intentionally not retained */ }
  if (body.includes('MissingSessionID')) providerErrorCode = 'MissingSessionID';
  return { providerErrorType, providerErrorCode };
}

async function summarizeResponse(response) {
  let finishReason = null, sseDone = false, providerErrorType = null, providerErrorCode = null;
  const contentType = response.headers.get('content-type') ?? '';
  try {
    const clone = response.clone();
    if (contentType.includes('text/event-stream')) {
      const reader = clone.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const consume = frame => { for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { sseDone = true; continue; }
        try {
          const item = JSON.parse(payload);
          for (const choice of item.choices ?? []) if (choice.index === 0 && choice.finish_reason) finishReason = choice.finish_reason;
          if (typeof item.error?.type === 'string') providerErrorType = item.error.type;
          if (typeof item.error?.code === 'string') providerErrorCode = item.error.code;
        } catch { /* retain only safe structural markers */ }
      } };
      if (reader) for (;;) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          consume(buffer.slice(0, match.index));
          buffer = buffer.slice(match.index + match[0].length);
        }
        if (done) { if (buffer.trim()) consume(buffer); break; }
        if (sseDone) { await reader.cancel(); break; }
      }
    } else if (!response.ok) {
      const reader = clone.body?.getReader();
      const decoder = new TextDecoder();
      let body = '';
      if (reader) {
        while (body.length < 65_536) {
          const { value, done } = await reader.read();
          body += decoder.decode(value ?? new Uint8Array(), { stream: !done });
          if (done) break;
        }
        await reader.cancel();
      }
      ({ providerErrorType, providerErrorCode } = summarizeProviderErrorBody(body));
    }
  } catch { /* metadata remains incomplete */ }
  return { finishReason, sseDone, providerErrorType, providerErrorCode };
}

function parseArgs(argv) {
  const options = { tasks: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help') { options.help = true; continue; }
    if (!['--state-root', '--task'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error('Use --help to see supported options.');
    }
    const value = argv[++i];
    if (flag === '--state-root') options.stateRoot = value;
    else options.tasks.push(value);
  }
  return options;
}

export async function runLiveTasks({ env = process.env, stateRoot, taskIds = LIVE_TASKS.map(task => task.id), log = console.log } = {}) {
  const { HARNESS_BASE_URL: baseUrl, HARNESS_MODEL: model, HARNESS_API_KEY: apiKey = '' } = env;
  if (!baseUrl || !model) throw new Error('Set HARNESS_BASE_URL and HARNESS_MODEL in the process environment.');
  const modelDirectory = 'model-' + createHash('sha256').update(model).digest('hex');
  const selectedTasks = taskIds.map(id => LIVE_TASKS.find(task => task.id === id));
  if (!selectedTasks.length || selectedTasks.some(task => !task) || new Set(taskIds).size !== taskIds.length) {
    throw new Error('Select one or more distinct task IDs listed by --help.');
  }
  const baseDirectory = resolve(stateRoot ?? join('.runs/live-evaluation', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`));
  await mkdir(baseDirectory, { recursive: true });
  if ((await readdir(baseDirectory)).length) throw new Error('Choose a fresh empty --state-root for each batch.');
  const addOpenCodeHeaders = env.HARNESS_OPENCODE_SESSION === '1' || env.HARNESS_OPENCODE_SESSION === 'true';
  if (env.HARNESS_OPENCODE_SESSION && !addOpenCodeHeaders) throw new Error('HARNESS_OPENCODE_SESSION accepts only 1 or true.');
  const userAgent = env.HARNESS_USER_AGENT || 'agent-harness-research-workbench/1.0';
  const results = [];

  for (const task of selectedTasks) {
    const runDirectory = join(baseDirectory, modelDirectory, task.id, 'run');
    await mkdir(join(baseDirectory, modelDirectory, task.id), { recursive: true });
    await mkdir(runDirectory);
    const requests = [];
    const sessionId = addOpenCodeHeaders ? randomUUID() : undefined;
    let activeRequest;
    const fetchImpl = async (input, init = {}) => {
      const headers = new Headers(init.headers);
      if (sessionId) {
        headers.set('x-opencode-session', sessionId);
        headers.set('user-agent', userAgent);
      }
      let response;
      try { response = await fetch(input, { ...init, headers }); }
      catch (error) {
        if (activeRequest) activeRequest.transport = { status: null, contentType: null,
          errorName: error?.name ?? 'Error', errorCode: typeof error?.code === 'string' ? error.code : null };
        throw error;
      }
      if (activeRequest) {
        activeRequest.transport = { status: response.status, contentType: response.headers.get('content-type'), errorName: null, errorCode: null };
        activeRequest.responseShapePromise = summarizeResponse(response);
      }
      return response;
    };
    const actualGateway = createChatGateway({ baseUrl, model, apiKey, fetchImpl });
    const gateway = {
      async next(input) {
        const record = { requestNumber: requests.length + 1, messages: input.messages, tools: input.tools };
        requests.push(record);
        activeRequest = record;
        try {
          const result = await actualGateway.next(input);
          if (record.responseShapePromise) record.responseShape = await record.responseShapePromise;
          delete record.responseShapePromise;
          record.response = result;
          return result;
        } catch (error) {
          if (record.responseShapePromise) record.responseShape = await record.responseShapePromise;
          delete record.responseShapePromise;
          record.error = { name: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : null,
            httpStatus: typeof error?.message === 'string' && /^Provider returned HTTP ([0-9]{3})$/.test(error.message) ? Number(error.message.match(/[0-9]{3}/)?.[0]) : null,
            protocolIncomplete: error?.message === 'Provider stream ended before its completion markers' };
          throw error;
        } finally { activeRequest = undefined; }
      },
    };

    let outcome;
    try { outcome = await runWorkbench({ directory: runDirectory, initial: { task: task.prompt }, gateway }); }
    catch (error) { outcome = { status: 'error', error: { name: error?.name ?? 'Error', message: 'Workbench run threw; no automatic retry performed.' } }; }
    let snapshot;
    try { snapshot = await readRunSnapshot(runDirectory); } catch { snapshot = undefined; }
    let delivery;
    try { delivery = await evaluateRun(runDirectory); }
    catch { delivery = { status: 'unavailable', message: 'Local delivery evaluation could not complete.' }; }
    const outcomeEvidence = { ...outcome };
    delete outcomeEvidence.directory;
    const evidence = {
      schema: 'research-workbench-live-evidence@1',
      capturedAt: new Date().toISOString(),
      task: { id: task.id, input: task.prompt },
      model: { id: model, credentialLoaded: Boolean(apiKey) },
      providerSessionHeaderEnabled: addOpenCodeHeaders,
      run: outcomeEvidence,
      modelExchange: requests,
      executionEvents: snapshot?.events ?? [],
      delivery,
    };
    const evidencePath = join(baseDirectory, modelDirectory, task.id, 'evidence.json');
    await writeFile(evidencePath, JSON.stringify(safe(evidence, apiKey), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    const result = { model, task: task.id, status: outcome.status, runId: snapshot?.run.id ?? null,
      requests: requests.length, toolCalls: snapshot?.events.filter(event => event.type === 'tool-start').length ?? 0,
      deliveryChecks: delivery?.checks?.map(check => ({ kind: check.kind, status: check.status, httpStatus: check.evidence?.httpStatus })) ?? [],
      evidence: relative(process.cwd(), evidencePath) };
    results.push(result);
    log(JSON.stringify(result));
  }
  await writeFile(join(baseDirectory, 'batch-summary.json'), JSON.stringify({ schema: 'research-workbench-live-batch@1', model, results }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { stateRoot: baseDirectory, results };
}

const help = `Usage: node scripts/run-live-tasks.mjs [--state-root DIR] [--task ID ...]

Required environment: HARNESS_BASE_URL, HARNESS_MODEL. HARNESS_API_KEY is optional.
Tasks: ${LIVE_TASKS.map(task => task.id).join(', ')} (defaults to all four)
Set HARNESS_OPENCODE_SESSION=1 only for services requiring x-opencode-session;
the runner then generates a new session ID for each Run and sends its Lab user-agent.
Each Run keeps the workbench's built-in budget. Failures are recorded and never retried.
`;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) console.log(help);
    else {
      const batch = await runLiveTasks({ stateRoot: args.stateRoot, taskIds: args.tasks.length ? args.tasks : undefined });
      if (batch.results.some(result => result.status !== 'completed')) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error?.message ?? 'Live run failed.');
    process.exitCode = 1;
  }
}
