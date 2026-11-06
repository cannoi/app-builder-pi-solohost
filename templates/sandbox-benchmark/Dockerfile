FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

RUN mkdir -p /app/runtime /tmp/sandbox-runtime \
 && addgroup -S app \
 && adduser -S app -G app \
 && chown -R app:app /app /tmp/sandbox-runtime

USER app

ENV PORT=8080 \
    NODE_ENV=production \
    HOME=/tmp

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node","server.js"]
