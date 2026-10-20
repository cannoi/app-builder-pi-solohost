FROM node:24-alpine
WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production
ENV PORT=8080
ENV BIND=0.0.0.0
ENV FACTORY_BIND=0.0.0.0
ENV DATA_DIR=/app/data
ENV WORKSPACE_DIR=/app/workspace
ENV PROJECTS_DIR=/app/projects

# Runtime tools only (no Chromium — E2E is optional / host-side)
RUN apk add --no-cache tini unzip git \
  && mkdir -p /app/data /app/workspace /app/projects

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock \
  && node --input-type=module -e "import('yaml').then(()=>console.log('yaml ok')).catch(e=>{console.error(e);process.exit(1)})" \
  && node --input-type=module -e "import('@octokit/rest').then(()=>console.log('octokit ok')).catch(e=>{console.error(e);process.exit(1)})" \
  && node --input-type=module -e "import('node:sqlite').then(()=>console.log('sqlite ok')).catch(e=>{console.error(e);process.exit(1)})"

COPY src ./src
COPY public ./public
COPY templates ./templates
COPY docs ./docs
COPY fallback ./fallback
COPY docker-entrypoint.sh ./docker-entrypoint.sh
COPY README.md INSTALL.md CHANGELOG.md ./

RUN chmod +x /app/docker-entrypoint.sh \
  && chown -R node:node /app

LABEL org.opencontainers.image.source="https://github.com/cannoi/app-builder-pi-solohost"

USER node
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node --input-type=module -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini","--"]
CMD ["/app/docker-entrypoint.sh"]
