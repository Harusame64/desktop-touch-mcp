FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

RUN npm ci --ignore-scripts \
  && npm run generate:stub-catalog \
  && npm run build \
  && npm prune --omit=dev

USER node
CMD ["node", "dist/index.js"]

