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
RUN pnpm prune --prod

FROM node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213 AS runtime

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/pnpm-lock.yaml /app/pnpm-lock.yaml
COPY --from=build /app/pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY --from=build /app/apps/control-plane/package.json /app/apps/control-plane/package.json
COPY --from=build /app/apps/control-plane/dist /app/apps/control-plane/dist
COPY --from=build /app/packages/protocol/package.json /app/packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist /app/packages/protocol/dist

USER node
CMD ["node", "apps/control-plane/dist/main.js"]
