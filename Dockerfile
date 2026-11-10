# syntax=docker/dockerfile:1
# AcademiaPath images for Google Cloud Run. One Dockerfile, three targets:
#   --target api      Fastify API (apps/api), production dependencies only
#   --target migrate  Drizzle migrations, run as a Cloud Run job before each API deploy
#   --target web      Next.js web app (apps/web); API_ORIGIN is fixed at build time by Next.js rewrites
# No secrets are baked into any image: DATABASE_URL and the rest arrive at runtime from Secret Manager.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# ---- Full install and build of every workspace ----
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
# Where the Next.js proxy forwards /api/*: the API's Cloud Run URL.
ARG API_ORIGIN=http://127.0.0.1:4000
ENV API_ORIGIN=${API_ORIGIN}
RUN pnpm build

# ---- Production dependencies of the API only ----
FROM base AS api-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --filter @academiapath/api

# ---- API runtime ----
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production API_HOST=0.0.0.0
WORKDIR /repo
COPY --from=api-deps /repo/node_modules ./node_modules
COPY --from=api-deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY apps/api/package.json ./apps/api/
WORKDIR /repo/apps/api
USER node
# Cloud Run sets PORT; server.ts reads API_PORT, then PORT.
CMD ["node", "dist/server.js"]

# ---- Migrations (drizzle-kit is a dev dependency, so this reuses the build stage) ----
FROM build AS migrate
WORKDIR /repo/apps/api
USER node
CMD ["pnpm", "run", "db:migrate"]

# ---- Web runtime ----
FROM build AS web
ENV NODE_ENV=production
WORKDIR /repo/apps/web
USER node
EXPOSE 3000
CMD ["pnpm", "run", "start"]
