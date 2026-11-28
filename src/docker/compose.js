export function generateCompose(config) {
  return `services:\n  app:\n    image: paf-app:pi-app-factory\n    restart: unless-stopped\n    environment:\n      - PORT=8080`;
}
