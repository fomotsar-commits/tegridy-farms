# The batcher as Railway runs it (railway.json): Node 24 runs the TypeScript directly, with the
# one runtime dependency and nothing else. The key lives on Railway's volume; the entrypoint
# refuses a key anywhere else, gives the volume to the `node` user and drops root before the
# batcher starts.
# Base pinned by digest (node 24.22.1, Debian bookworm, slim): a wrong digest fails the pull, it
# can never fetch something else. CI runs the tests on the Node this line names; Dependabot
# proposes newer ones (.github/dependabot.yml).
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/batcher-entrypoint
RUN chmod 0755 /usr/local/bin/batcher-entrypoint

ENTRYPOINT ["/usr/local/bin/batcher-entrypoint"]
