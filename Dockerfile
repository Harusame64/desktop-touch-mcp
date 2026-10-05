FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
# Native addon ESM wrapper + type defs — required by src/engine/native-engine.ts
# at tsc compile time. The .node binary is Windows-only, so on Linux the
# runtime load of index.js will throw and the module falls back to null.
COPY index.js index.d.ts ./
COPY src ./src
COPY scripts ./scripts

# The stub catalog (src/stub-tool-catalog.ts) is committed and CI checks it against the Windows
# server's tools/list; it is not regenerated here — the generator registers the real tools under
# vitest, and this image carries neither the tests nor the vitest config (internal #252).
RUN npm ci --include=dev --ignore-scripts \
  && npm run build \
  && npm prune --omit=dev

ENV NODE_ENV=production
USER node
CMD ["node", "dist/index.js"]
