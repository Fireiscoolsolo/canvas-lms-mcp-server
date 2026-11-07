# Canvas MCP Remote in a container, for a home server or NAS. See docker-compose.yml and the README's Docker section.
# Settings come from environment variables (env_file: .env); logins and state persist in the /data volume.
# Pinned to a version and its digest, so a rebuild uses exactly what was tested. To update, pick a newer node:22
# alpine tag on Docker Hub and its sha256 digest.
FROM node:22.23.4-alpine3.24@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

# Listen on all interfaces inside the container, and trust the tunnel container's forwarded visitor address.
ENV NODE_ENV=production \
    CANVAS_MCP_HOST=0.0.0.0 \
    CANVAS_MCP_TRUST_PROXY=uniquelocal

RUN mkdir -p /data && chown node:node /data
VOLUME /data
WORKDIR /data
USER node
EXPOSE 3939

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3939/healthz || exit 1
CMD ["node", "/app/index.js"]
