const en = {
  title: 'App Builder — Pi SoloHost',
  tagline: 'Tell me what you want to build. I will handle the technical work.',
  ideaPlaceholder: 'Tell me the app you want. I will lead the rest.',
  buildApp: 'Build app',
  tryDemo: 'Try demo',
  projects: 'Projects',
  ready: 'Ready',
  needsSetup: 'Setup needed',
  wizardTitle: 'Settings',
  wizardAi: 'AI provider',
  wizardKey: 'API key',
  wizardGithub: 'GitHub (optional)',
  wizardDocker: 'Docker mode',
  save: 'Save',
  skip: 'Skip for now',
  acceptPlan: 'Build app',
  changePlan: 'Change plan',
  askAi: 'Ask AI',
  advanced: 'Advanced',
  approveRelease: 'Approve release',
  rollback: 'Rollback',
};

export function t(_locale, key) { return en[key] || key; }
export function catalog() { return en; }
export const locales = ['en'];
