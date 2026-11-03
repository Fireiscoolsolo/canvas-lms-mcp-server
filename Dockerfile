# Canvas MCP Remote in a container, for a home server or NAS. See docker-compose.yml and the README's Docker section.
# Settings come from environment variables (env_file: .env); logins and state persist in the /data volume.
FROM node:22-alpine

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
