import { promises as fs } from 'fs';

export function createJsonFileStore(filePath, defaults = {}) {
  let data = { ...defaults };

  async function load() {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      data = JSON.parse(content);
    } catch (err) {
      // Use defaults if file doesn't exist
    }
  }

  async function save() {
    try {
      await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Failed to save store:', err);
    }
  }

  return {
    async listCollections() {
      return Object.keys(data);
    },
    async list(collection) {
      await load();
      return data[collection] || [];
    },
    async get(collection, id) {
      await load();
      const list = data[collection] || [];
      return list.find(item => item.id === id) || null;
    },
    async put(collection, record) {
      await load();
      if (!data[collection]) data[collection] = [];
      const idx = data[collection].findIndex(item => item.id === record.id);
      if (idx !== -1) {
        data[collection][idx] = record;
      } else {
        data[collection].push(record);
      }
      await save();
      return record;
    },
    async delete(collection, id) {
      await load();
      if (data[collection]) {
        data[collection] = data[collection].filter(item => item.id !== id);
        await save();
      }
      return { success: true };
    }
  };
}