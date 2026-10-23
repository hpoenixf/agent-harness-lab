import { resolve, join } from 'node:path';
import { mkdir, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { openWorkbench, runWorkbench } from './workbench.mjs';
import { createChatGateway } from './gateway.mjs';
import { loadConfig, createConfigTemplate } from './config.mjs';
import { createSourceStore } from './sources.mjs';
import { createArtifactStore } from './artifacts.mjs';
import { createPublicationStore } from './publication.mjs';
import { createReaderServer } from './server.mjs';

export async function main(argv = process.argv.slice(2)) {
  const [command = 'demo', ...options] = argv;
  const allowed = new Set(['--state', '--live', '--interrupt-after-save', '--port', '--config']);
  for (let i = 0; i < options.length; i++) {
    if (!allowed.has(options[i])) throw new Error(`Unknown option: ${options[i]}`);
    if (['--state', '--port', '--config'].includes(options[i])) {
      if (!options[i + 1] || options[i + 1].startsWith('--')) throw new Error(`Missing value for ${options[i]}`);
      i++;
    }
  }
  const value = name => options.includes(name) ? options[options.indexOf(name) + 1] : undefined;
  const directory = resolve(value('--state') ?? '.runs/workbench');
  const configPath = value('--config') === undefined ? undefined : resolve(value('--config'));
  const live = options.includes('--live');
  if (command === 'configure') {
    console.log(JSON.stringify(await createConfigTemplate(configPath)));
    return;
  }
  // Offline commands do not need to read a Key or even have a configuration file.
  const modelConfig = live && ['demo', 'resume', 'background'].includes(command) ? await loadConfig({ configPath }) : undefined;
  if (['demo', 'resume'].includes(command)) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      let gateway;
      if (live) {
        gateway = createChatGateway(modelConfig);
        // The same explicit provider choice supplies derived summaries; Host counts it.
        gateway.summarize = async (basis, { signal } = {}) => {
          const result = await gateway.next({ messages: [{ role: 'system', text: '将已结算历史写成简短工作笔记。保留条件与原始sourceId，不认证结论或执行。' }, { role: 'user', text: JSON.stringify(basis) }], tools: [], signal: signal ?? controller.signal });
          if (result.complete === false || result.calls.length) throw new Error('Summary did not complete');
          return result.text;
        };
      }
      const result = await runWorkbench({ directory, gateway, signal: controller.signal,
        afterPublish: options.includes('--interrupt-after-save') ? () => process.exit(75) : undefined });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== 'completed') process.exitCode = 2;
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    return;
  }
  if (command === 'background') {
    if (live) createChatGateway(modelConfig); // Validate settings without calling a model.
    await mkdir(directory, { recursive: true });
    const log = await open(join(directory, 'worker.log'), 'a');
    const args = [fileURLToPath(new URL('./worker.mjs', import.meta.url)), '--state', directory];
    if (configPath !== undefined) args.push('--config', configPath);
    if (live) args.push('--live');
    if (options.includes('--interrupt-after-save')) args.push('--interrupt-after-save');
    // Key travels only in the child's environment, never command arguments or Run state.
    const env = modelConfig ? { ...process.env, HARNESS_BASE_URL: modelConfig.baseUrl, HARNESS_MODEL: modelConfig.model, HARNESS_API_KEY: modelConfig.apiKey } : process.env;
    const child = spawn(process.execPath, args, { detached: true, env, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    await log.close();
    console.log(JSON.stringify({ status: 'started', pid: child.pid, directory, log: join(directory, 'worker.log') }));
    return;
  }
  if (command === 'serve') {
    // Refresh publication state per read: the worker may be another process.
    const sources = await createSourceStore(join(directory, 'sources'));
    const artifacts = await createArtifactStore(join(directory, 'artifacts'));
    const fresh = () => createPublicationStore(join(directory, 'publications'), { sources, artifacts });
    const publications = { list: async () => (await fresh()).list(), get: async (...args) => (await fresh()).get(...args) };
    const port = Number(value('--port') ?? 0);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
    const server = await createReaderServer({ publications, sources, artifacts, port });
    console.log(server.url);
    const close = async () => { await server.close(); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return;
  }
  if (['inspect', 'cancel'].includes(command)) {
    const work = await openWorkbench(directory);
    try {
      if (command === 'cancel') await work.store.cancel();
      console.log(JSON.stringify({ run: work.store.run, events: work.store.events(), publications: await work.publications.list() }, null, 2));
    } finally { await work.close(); }
    return;
  }
  throw new Error('Use configure, demo, resume, background, serve, inspect, or cancel');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
