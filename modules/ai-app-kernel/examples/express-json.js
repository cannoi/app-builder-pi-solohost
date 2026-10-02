import express from 'express';
import { createAiKernel, createActionRegistry, createJsonFileStore } from '../src/index.js';

const store = createJsonFileStore('./data/app.json', { notes: [] });
const actions = createActionRegistry()
  .register({
    name: 'add_note',
    description: 'Add a note',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async run({ text }) { return store.put('notes', { text, createdAt: new Date().toISOString() }); },
  });

const ai = createAiKernel({
  schema: { name: 'notes-app', collections: [{ name: 'notes', fields: ['id', 'text', 'createdAt'] }] },
  store,
  actions,
});

const app = express();
app.use(express.json());
ai.mount(app, '/ai');
app.listen(process.env.PORT || 8080);
