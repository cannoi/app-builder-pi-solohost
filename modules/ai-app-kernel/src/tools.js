const DB_TOOLS = [
  {
    name: 'app_schema',
    description: 'Read the app data model and available collections/tables.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'app_capabilities',
    description: 'List actions the AI may call to control this app.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'db_list',
    description: 'List records from a collection/table. Optional exact-match filter.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        filter: { type: 'object' },
      },
      required: ['collection'],
    },
  },
  {
    name: 'db_get',
    description: 'Get one record by id.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        id: { type: 'string' },
      },
      required: ['collection', 'id'],
    },
  },
  {
    name: 'db_put',
    description: 'Create or update one record. Must include id when updating.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        record: { type: 'object' },
      },
      required: ['collection', 'record'],
    },
  },
  {
    name: 'db_delete',
    description: 'Delete one record by id.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        id: { type: 'string' },
      },
      required: ['collection', 'id'],
    },
  },
  {
    name: 'app_invoke',
    description: 'Run a registered app action by name.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        args: { type: 'object' },
      },
      required: ['name'],
    },
  },
];

export function kernelTools() {
  return DB_TOOLS;
}

export async function runTool(name, args, { store, schema, actions, ctx }) {
  if (name === 'app_schema') {
    const safeSchema = filterSchema(schema);
    return { schema: safeSchema, collections: safeSchema.collections.map((item) => item.name) };
  }
  if (name === 'app_capabilities') return { actions: actions.list() };
  if (name === 'db_list') {
    const def = assertAllowed(schema, args.collection);
    assertFields(def, Object.keys(args.filter || {}));
    const fields = allowedFields(def);
    return { items: (await store.list(args.collection, args.filter || {})).map((item) => selectFields(item, fields)) };
  }
  if (name === 'db_get') {
    const def = assertAllowed(schema, args.collection);
    assertFields(def, ['id']);
    const item = await store.get(args.collection, args.id);
    return { item: item ? selectFields(item, allowedFields(def)) : null };
  }
  if (name === 'db_put') {
    const def = assertAllowed(schema, args.collection);
    const record = args.record || {};
    assertFields(def, Object.keys(record));
    return { item: selectFields(await store.put(args.collection, record), allowedFields(def)) };
  }
  if (name === 'db_delete') {
    const def = assertAllowed(schema, args.collection);
    assertFields(def, ['id']);
    return store.delete(args.collection, args.id);
  }
  if (name === 'app_invoke') return actions.invoke(args.name, args.args || {}, ctx);
  throw new Error(`Unknown tool: ${name}`);
}

function assertAllowed(schema, collection) {
  const def = (schema?.collections || []).find((item) => item?.name === collection);
  if (!def || isSensitive(collection)) {
    throw new Error(`Collection "${collection}" is not in the app schema.`);
  }
  return def;
}

function assertFields(def, fields) {
  const allowed = allowedFields(def);
  if (!allowed.size) throw new Error(`Collection "${def.name}" has no field allowlist.`);
  for (const field of fields) {
    if (!allowed.has(field) || isSensitive(field)) {
      throw new Error(`Field "${field}" is not allowed for collection "${def.name}".`);
    }
  }
}

function allowedFields(def) {
  return new Set(Array.isArray(def.fields) ? def.fields.filter((field) => !isSensitive(field)) : []);
}

function selectFields(record, fields) {
  return Object.fromEntries(Object.entries(record || {}).filter(([field]) => fields.has(field)));
}

function isSensitive(value) {
  return /(?:secret|credential|password|token|private|wallet|api[_-]?key)/i.test(String(value || ''));
}

export function filterSchema(schema) {
  const collections = (schema?.collections || [])
    .filter((item) => item?.name && !isSensitive(item.name))
    .map((item) => ({
      name: item.name,
      fields: Array.isArray(item.fields) ? item.fields.filter((field) => !isSensitive(field)) : [],
    }));
  return { name: String(schema?.name || 'app'), collections };
}
