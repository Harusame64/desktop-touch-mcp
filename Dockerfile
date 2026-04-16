FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

RUN npm ci --include=dev --ignore-scripts \
  && npm run generate:stub-catalog \
  && npm run build \
  && npm prune --omit=dev

ENV NODE_ENV=production
USER node
CMD ["node", "dist/index.js"]
