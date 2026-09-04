FROM node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213 AS build

WORKDIR /app
ENV COREPACK_HOME=/tmp/corepack

RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm --filter @qhb/control-plane deploy --offline --prod --legacy /app/runtime
RUN node scripts/runtime/prune-production-dependencies.mjs /app/runtime

FROM node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213 AS runtime

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/runtime/ /app/

USER node
CMD ["node", "dist/main.js"]
