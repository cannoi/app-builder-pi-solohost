FROM node:24-alpine
WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium-browser

RUN apk add --no-cache tini unzip git chromium \
  && mkdir -p /app/data /app/workspace /app/projects \
  && chown -R node:node /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock

COPY src ./src
COPY public ./public
COPY templates ./templates
COPY docs ./docs
COPY fallback ./fallback
COPY README.md INSTALL.md CHANGELOG.md ./

LABEL org.opencontainers.image.source="https://github.com/cannoi/app-builder-pi-solohost"

USER node
EXPOSE 8080

HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","src/server.js"]
