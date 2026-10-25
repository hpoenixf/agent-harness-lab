# Running the synthetic research workbench with a live model

`scripts/run-live-tasks.mjs` runs four novice-style questions against the supplied synthetic product manuals through the public research-workbench gateway and tools. It saves each Run's model inputs and responses, tool events, final answer, and local delivery checks. A live provider call is made for every model request; the bundled fixture gateway is not used.

## Configure an already authorized compatible route

Provide the endpoint, model name, and any required key through the provider's approved environment or secret manager. The runner reads only these environment values and does not write the key into its evidence files.

```sh
export HARNESS_BASE_URL='https://api.example/v1'
export HARNESS_MODEL='your-compatible-model'
# Supply HARNESS_API_KEY through your existing secure environment injection when required.
node scripts/run-live-tasks.mjs --state-root .runs/live-evaluation/session-01
```

The `--state-root` must be fresh for each batch. The runner refuses to reuse an existing per-task Run directory. Each Lab Run keeps its built-in budget of 24 model requests and 80 tool calls. It adds no outer timeout, retry, or fallback. A failed question is recorded as failed, and independent questions continue.

To run selected tasks, repeat `--task` with one or more IDs:

```sh
node scripts/run-live-tasks.mjs --state-root .runs/live-evaluation/session-02 \
  --task free-offline-editing --task export-limit-change
```

The supported IDs are `export-history`, `free-offline-editing`, `export-limit-change`, and `cited-downloadable-report`. The four prompts are stored in the script so repeated runs use the same wording.

## Provider-specific session headers

The default gateway sends the normal OpenAI-compatible request headers. Some compatible services additionally require a request correlation header. For a service that documents this requirement, set:

```sh
HARNESS_OPENCODE_SESSION=1 node scripts/run-live-tasks.mjs --state-root .runs/live-evaluation/session-03
```

This opt-in adds `x-opencode-session` with a fresh random identifier for each Run and sends the workbench user-agent. Leave it unset for services that do not require those headers. The session value is not an authentication credential and is not written to evidence.

## Evidence and delivery checks

The state root contains one directory per model and task. Each `evidence.json` retains the exact user question, model request messages and tool schemas, returned model text or tool proposals, Lab execution events, and the final answer. It omits credentials and local absolute Run paths. `batch-summary.json` gives the run statuses and check results.

After each Run, the Lab's existing evaluator reads the saved publication and downloads its source windows and attachments over the workbench's local HTTP routes. These checks establish whether the registered report and bytes can be retrieved. They do not assess whether claims are correct or citations support them; semantic quality remains `unreviewed` until a person compares the answer with the synthetic source pages.
