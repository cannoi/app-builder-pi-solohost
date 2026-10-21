import fs from 'node:fs/promises';
import path from 'node:path';

export async function loadOrchestratorState(projectDir) {
  try {
    const raw = await fs.readFile(path.join(projectDir, 'orchestrator-state.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveOrchestratorState(projectDir, state) {
  const file = path.join(projectDir, 'orchestrator-state.json');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(state, null, 2));
  return file;
}

export function emptyState({ goal = '', plan = null } = {}) {
  return {
    version: 3,
    goal,
    plan,
    tasks: {},
    decisions: [],
    attempts: [],
    updatedAt: new Date().toISOString(),
  };
}
