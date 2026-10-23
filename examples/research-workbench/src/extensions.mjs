const registrations = new WeakMap();
const copy = value => structuredClone(value);
const errorInfo = (code, error) => ({ code, message: error instanceof Error ? error.message : String(error) });
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

// Teaching subset: type, properties, required, additionalProperties, items,
// enum, minLength/maxLength, minItems/maxItems, minimum/maximum, description.
// Unsupported keywords fail registration rather than claiming validation.
const keywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum', 'description']);
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
function checkSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new TypeError('inputSchema must be an object');
  for (const key of Object.keys(schema)) if (!keywords.has(key)) throw new TypeError(`Unsupported schema keyword: ${key}`);
  if (schema.type !== undefined && !types.has(schema.type)) throw new TypeError('Unsupported schema type');
  if (schema.properties) for (const child of Object.values(schema.properties)) checkSchema(child);
  if (schema.items) checkSchema(schema.items);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') throw new TypeError('additionalProperties must be boolean');
  if (schema.required && (!Array.isArray(schema.required) || !schema.required.every(key => typeof key === 'string'))) throw new TypeError('required must contain strings');
  if (schema.enum && !Array.isArray(schema.enum)) throw new TypeError('enum must be an array');
}
function validateSchema(schema, value, path = 'args') {
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type && !(schema.type === 'integer' ? Number.isSafeInteger(value) : actual === schema.type && (actual !== 'number' || Number.isFinite(value)))) return `${path} must be ${schema.type}`;
  if (schema.enum && !schema.enum.some(candidate => JSON.stringify(candidate) === JSON.stringify(value))) return `${path} is not an allowed value`;
  if (actual === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return `${path}.${key} is required`;
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) {
        const error = validateSchema(schema.properties[key], item, `${path}.${key}`);
        if (error) return error;
      } else if (schema.additionalProperties === false) return `${path}.${key} is not allowed`;
    }
  }
  if (actual === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} has too few items`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} has too many items`;
    if (schema.items) for (const item of value) { const error = validateSchema(schema.items, item, `${path}[]`); if (error) return error; }
  }
  if (actual === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} is too short`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} is too long`;
  }
  if (actual === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} is below minimum`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} is above maximum`;
  }
}

export function createToolRegistry() {
  const tools = new Map();
  const registry = {
    register(name, { description, inputSchema, execute, validate } = {}) {
      if (typeof name !== 'string' || !name || typeof description !== 'string' || typeof execute !== 'function' || (validate !== undefined && typeof validate !== 'function')) throw new TypeError('Tool requires a name, description, inputSchema and execute function');
      if (tools.has(name)) throw new Error(`Duplicate tool: ${name}`);
      checkSchema(inputSchema);
      tools.set(name, { description, inputSchema: freeze(copy(inputSchema)), execute, validate });
      return registry;
    },
    descriptions() {
      return [...tools].map(([name, { description, inputSchema }]) => ({ name, description, inputSchema: copy(inputSchema) }));
    },
    async dispatch({ id, name, args }, context) {
      const base = { id, name, args: copy(args), dispatched: false };
      const tool = tools.get(name);
      if (!tool) return { ...base, status: 'failed', error: errorInfo('unknown_tool', 'Tool is not registered') };
      try {
        const schemaError = validateSchema(tool.inputSchema, args);
        const custom = schemaError ? undefined : await tool.validate?.(args);
        if (schemaError || custom === false || typeof custom === 'string') return { ...base, status: 'failed', error: errorInfo('invalid_arguments', schemaError ?? (custom || 'Custom validation failed')) };
      } catch (error) {
        return { ...base, status: 'failed', error: errorInfo('invalid_arguments', error) };
      }
      try {
        return { ...base, dispatched: true, status: 'completed', output: await tool.execute(copy(args), context) };
      } catch (error) {
        return { ...base, dispatched: true, status: 'failed', error: errorInfo('tool_failed', error) };
      }
    },
  };
  registrations.set(registry, tools);
  return registry;
}

/** One trusted built-in extension may replace its complete active generation. */
export function createExtensionHost({ registry }) {
  if (!registrations.has(registry)) throw new TypeError('Expected a registry created by createToolRegistry');
  const baseTools = new Map(registrations.get(registry));
  let sequence = 0;
  let disposed = false;
  let activation = 0;
  function makeGeneration(name, version, contribution = {}) {
    const local = createToolRegistry();
    for (const [toolName, tool] of baseTools) local.register(toolName, tool);
    for (const { name: toolName, ...tool } of contribution.tools ?? []) local.register(toolName, tool);
    const hooks = (contribution.hooks ?? []).map(hook => {
      if (typeof hook.id !== 'string' || (hook.before !== undefined && typeof hook.before !== 'function') || (hook.after !== undefined && typeof hook.after !== 'function')) throw new TypeError('Hooks require an id and optional before/after functions');
      return { ...hook };
    });
    return { generation: sequence, name, version, registry: local, skills: freeze(copy(contribution.skills ?? [])), hooks, cleanup: contribution.dispose, leases: 0, retired: false, cleaned: false };
  }
  let current = makeGeneration('base', '0');
  async function cleanup(generation) {
    if (!generation.retired || generation.leases || generation.cleaned) return;
    generation.cleaned = true;
    try { await generation.cleanup?.(); }
    catch (error) { return { generation: generation.generation, ...errorInfo('cleanup_failed', error) }; }
  }
  async function dispatch(generation, call, context) {
    let effective = copy(call);
    let receipt;
    for (const hook of generation.hooks) {
      try {
        const normalized = await hook.before?.(freeze(copy(effective)), context);
        if (normalized && Object.hasOwn(normalized, 'args')) effective = { ...effective, args: copy(normalized.args) };
      } catch (error) {
        receipt = { id: call.id, name: call.name, args: effective.args, dispatched: false, status: 'failed', error: errorInfo('before_hook_failed', error) };
        break;
      }
    }
    receipt ??= await generation.registry.dispatch(effective, context);
    receipt.originalArgs = copy(call.args);
    for (const hook of generation.hooks) {
      try { await hook.after?.(freeze(copy(receipt)), context); }
      catch (error) { (receipt.observations ??= []).push({ hookId: hook.id, ...errorInfo('after_hook_failed', error) }); }
    }
    return receipt;
  }
  const host = {
    async activate({ name, version, contribute }) {
      let contribution;
      const ticket = ++activation;
      try {
        if (disposed) throw new Error('Extension host is disposed');
        if (typeof name !== 'string' || typeof version !== 'string' || typeof contribute !== 'function') throw new TypeError('Activation requires name, version and trusted contribute function');
        contribution = await contribute();
        if (!contribution || typeof contribution !== 'object') throw new TypeError('contribute must return a contribution object');
        const candidate = makeGeneration(name, version, contribution);
        if (disposed || ticket !== activation) throw new Error('Activation was superseded or host disposed');
        candidate.generation = ++sequence;
        const previous = current;
        current = candidate; // One assignment publishes tools, hooks and skills together.
        previous.retired = true;
        const observation = await cleanup(previous);
        return { status: 'active', generation: candidate.generation, ...(observation ? { observations: [observation] } : {}) };
      } catch (error) {
        try { await contribution?.dispose?.(); } catch { /* Preserve activation's original failure. */ }
        return { status: 'failed', error: errorInfo('activation_failed', error) };
      }
    },
    acquire() {
      if (disposed) throw new Error('Extension host is disposed');
      const captured = current;
      captured.leases++;
      let released = false;
      return {
        generation: captured.generation, version: captured.version, skills: captured.skills,
        descriptions: () => captured.registry.descriptions(),
        dispatch: (call, context) => {
          if (released) return Promise.resolve({ id: call.id, name: call.name, args: copy(call.args), status: 'failed', dispatched: false, error: errorInfo('released_generation', 'Generation lease was released') });
          return dispatch(captured, call, context);
        },
        async release() { if (!released) { released = true; captured.leases--; return cleanup(captured); } },
      };
    },
    descriptions: () => current.registry.descriptions(),
    async dispatch(call, context) {
      const lease = host.acquire();
      let receipt;
      try { receipt = await lease.dispatch(call, context); }
      finally {
        const observation = await lease.release();
        if (observation && receipt) (receipt.observations ??= []).push(observation);
      }
      return receipt;
    },
    async dispose() { if (!disposed) { disposed = true; activation++; current.retired = true; return cleanup(current); } },
  };
  return host;
}
