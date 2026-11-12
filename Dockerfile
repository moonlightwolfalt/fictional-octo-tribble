# The mope.io archive server: Node built-ins only, no npm install needed.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080

COPY package.json server.js ./
COPY lib ./lib
COPY archive ./archive

# Sevalla (and most hosts) set PORT; the server listens on 0.0.0.0:$PORT.
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "server.js"]
