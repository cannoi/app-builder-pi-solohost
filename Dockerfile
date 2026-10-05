# Personal AI Hub with *managed* Ollama in the same container.
# Avoids broken/empty ollama/ollama sidecar images on SoloHost (0-byte pulls).
# No docker.sock. No host install. Models persist on /app/ollama-data volume.

FROM node:18-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget \
    && rm -rf /var/lib/apt/lists/*

# Install Ollama CLI/server binary for the build architecture (amd64 / arm64)
ARG TARGETARCH
RUN set -eux; \
  arch="${TARGETARCH:-amd64}"; \
  case "$arch" in \
    amd64|x86_64) arch=amd64 ;; \
    arm64|aarch64) arch=arm64 ;; \
    *) echo "WARN: unsupported arch $arch for Ollama — Local AI disabled"; exit 0 ;; \
  esac; \
  curl -fsSL -o /tmp/ollama.tgz \
    "https://github.com/ollama/ollama/releases/download/v0.6.8/ollama-linux-${arch}.tgz"; \
  mkdir -p /tmp/ollama-extract; \
  tar -xzf /tmp/ollama.tgz -C /tmp/ollama-extract; \
  if [ -f /tmp/ollama-extract/bin/ollama ]; then \
    mv /tmp/ollama-extract/bin/ollama /usr/local/bin/ollama; \
  elif [ -f /tmp/ollama-extract/ollama ]; then \
    mv /tmp/ollama-extract/ollama /usr/local/bin/ollama; \
  else \
    find /tmp/ollama-extract -type f -name ollama -exec mv {} /usr/local/bin/ollama \; ; \
  fi; \
  chmod +x /usr/local/bin/ollama; \
  /usr/local/bin/ollama --version || true; \
  rm -rf /tmp/ollama.tgz /tmp/ollama-extract

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .
RUN chmod +x /app/docker-entrypoint.sh \
  && mkdir -p /app/data /app/ollama-data

ENV PORT=8080 \
    SERVICE_NAME=personal-ai-hub \
    DATA_DIR=/app/data \
    NODE_ENV=production \
    OLLAMA_HOST=127.0.0.1:11434 \
    OLLAMA_MODELS=/app/ollama-data \
    OLLAMA_BASE_URL=http://127.0.0.1:11434 \
    OLLAMA_SERVICE=

EXPOSE 8080

# Longer start period: Ollama may need a minute on first boot / slow disks
HEALTHCHECK --interval=30s --timeout=8s --start-period=60s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
# Fallback if platform strips ENTRYPOINT:
CMD ["node", "index.js"]
