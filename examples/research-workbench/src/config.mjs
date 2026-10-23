import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

// Never search cwd or parent folders: this example owns exactly one default file.
export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../.env', import.meta.url));
const fields = { baseUrl: 'HARNESS_BASE_URL', model: 'HARNESS_MODEL', apiKey: 'HARNESS_API_KEY' };
const template = `# This file belongs only to the research-workbench example.
# configure creates it without contacting any model. Use --live to opt in.
# Replace the local URL and model with your compatible provider's settings.
HARNESS_BASE_URL=http://127.0.0.1:1234/v1
HARNESS_MODEL=replace-with-your-model
# Leave empty for a provider that needs no Key; otherwise enter your own Key.
HARNESS_API_KEY=
`;

export async function loadConfig({ configPath, env = process.env } = {}) {
  let file = {};
  try { file = parseEnv(await readFile(configPath === undefined ? DEFAULT_CONFIG_PATH : resolve(configPath), 'utf8')); }
  catch (error) {
    if (!(configPath === undefined && error.code === 'ENOENT')) {
      // Parser/IO diagnostics must not echo a configuration line containing Key.
      throw new Error(`Cannot read configuration file${error.code ? ` (${error.code})` : ''}`);
    }
  }
  return Object.fromEntries(Object.entries(fields).map(([field, name]) => [field, String(env[name] === undefined ? file[name] ?? '' : env[name])]));
}

export async function createConfigTemplate(configPath = DEFAULT_CONFIG_PATH) {
  const path = resolve(configPath);
  try {
    await writeFile(path, template, { flag: 'wx', mode: 0o600 });
    return { status: 'created', path };
  } catch (error) {
    if (error.code === 'EEXIST') return { status: 'exists', path };
    throw new Error(`Cannot create configuration file${error.code ? ` (${error.code})` : ''}`);
  }
}
