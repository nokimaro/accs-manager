# syntax=docker/dockerfile:1.7
FROM node:26-trixie-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# Node 26 ships without corepack
RUN npm i -g pnpm@12.8.2
WORKDIR /app

# ---- manifests only (cache-friendly) ----
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/

# ---- build the SPA ----
FROM manifests AS web-build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "web..."
COPY tsconfig.json tsconfig.node.json ./
COPY packages/ui packages/ui
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter web build

# ---- production deps of api and its workspace packages (symlinked, not injected) ----
FROM manifests AS api-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter "api..."

# ---- runtime: Node runs the TypeScript sources directly (type stripping) ----
FROM node:26-trixie-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-deps --chown=node:node /app ./
COPY --chown=node:node packages/shared/src packages/shared/src
COPY --chown=node:node packages/db/src packages/db/src
COPY --chown=node:node packages/db/drizzle packages/db/drizzle
COPY --chown=node:node packages/server/src packages/server/src
COPY --chown=node:node apps/api/src apps/api/src
COPY --from=web-build --chown=node:node /app/apps/web/dist apps/web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/api/src/main.ts"]
