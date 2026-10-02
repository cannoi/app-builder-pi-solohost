export function createActionRegistry() {
  const actions = new Map();
  return {
    register(action) {
      if (!action?.name || typeof action.run !== 'function') throw new Error('Action needs name and run().');
      actions.set(action.name, {
        name: action.name,
        description: action.description || '',
        parameters: action.parameters || { type: 'object', properties: {} },
        run: action.run,
      });
      return this;
    },
    list() {
      return [...actions.values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
    },
    async invoke(name, args = {}, ctx = {}) {
      const action = actions.get(name);
      if (!action) throw new Error(`Unknown action: ${name}`);
      return action.run(args, ctx);
    },
  };
}
