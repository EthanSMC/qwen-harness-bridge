FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /app
ENV COREPACK_HOME=/tmp/corepack

RUN corepack_version="$(corepack --version)" \
  && printf 'corepack_version=%s\n' "$corepack_version" \
  && test "$corepack_version" = "0.34.6" \
  && corepack enable \
  && corepack install --global pnpm@10.15.1 \
  && pnpm_version="$(pnpm --version)" \
  && printf 'pnpm_version=%s\n' "$pnpm_version" \
  && test "$pnpm_version" = "10.15.1"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/harness-plugin/package.json packages/harness-plugin/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm --filter @qhb/control-plane deploy --offline --prod /app/runtime
RUN node scripts/runtime/prune-production-dependencies.mjs /app/runtime

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/runtime/ /app/

USER node
CMD ["node", "dist/main.js"]
