# The batcher as Railway runs it (railway.json): Node 24 runs the TypeScript directly, with the
# one runtime dependency and nothing else. The key lives on Railway's volume; the entrypoint
# gives its folder to the `node` user and drops root before the batcher starts.
# Base pinned by digest (node 24.13.0, Debian bookworm, slim): a wrong digest fails the pull, it
# can never fetch something else.
FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/batcher-entrypoint
RUN chmod 0755 /usr/local/bin/batcher-entrypoint

ENTRYPOINT ["/usr/local/bin/batcher-entrypoint"]
