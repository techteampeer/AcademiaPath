# AcademiaPath

Bilingual (Spanish/English) institutional learning management system for a university in Peru.

## Stack

| Area      | Technology                                          |
| --------- | --------------------------------------------------- |
| Monorepo  | pnpm workspaces                                     |
| Frontend  | Next.js (App Router) + TypeScript + Tailwind CSS    |
| Backend   | Fastify + Node.js + TypeScript                      |
| Contract  | OpenAPI 3.1 (`packages/contract/openapi.yaml`)      |
| Database  | PostgreSQL + Drizzle ORM (`apps/api/src/db`)        |
| Planned   | Google Cloud                                        |

## Prerequisites

- Node.js 22.19 or newer
- pnpm 10 (`corepack enable` picks up the pinned version)

## Getting started

```bash
pnpm install
cp .env.example .env   # optional; defaults work for local development
pnpm dev               # web on http://localhost:3000, API on http://localhost:4000
```

Health check: `curl http://localhost:4000/api/v1/health`

## Scripts (run from the repository root)

| Command                 | Description                              |
| ----------------------- | ---------------------------------------- |
| `pnpm dev`              | Start web and API in watch mode          |
| `pnpm dev:web`          | Start only the web app                   |
| `pnpm dev:api`          | Start only the API                       |
| `pnpm typecheck`        | Type-check all workspaces                |
| `pnpm build`            | Build all workspaces                     |
| `pnpm validate:openapi` | Validate the OpenAPI 3.1 specification   |
| `pnpm test`             | Run tests                                |
| `pnpm db:generate`      | Generate a SQL migration from the schema |
| `pnpm db:check`         | Validate the migration history           |
| `pnpm db:migrate`       | Apply migrations to `DATABASE_URL`       |

## Database

The schema lives in `apps/api/src/db/schema/`; versioned SQL migrations live in `apps/api/drizzle/`.

1. Use a local PostgreSQL 16 server (never the institutional database) and create a database, e.g. `createdb academiapath_dev`.
2. Set `DATABASE_URL` in the root `.env` (see `.env.example`). Credentials belong only in your uncommitted `.env`.
3. Apply migrations: `pnpm db:migrate`.

After changing the schema, run `pnpm db:generate`, review the generated SQL and commit it together with the schema change.

`pnpm test` always runs the static schema checks. To also run the migration and constraint tests, set `TEST_DATABASE_URL` to a local server whose role can create databases (e.g. `postgresql://postgres@127.0.0.1:5432/postgres`); the tests create and drop a temporary database.

## Structure

```
apps/
  web/         Next.js frontend (UI only — no business logic or secrets)
  api/         Fastify backend (auth, grading, AI and all business logic)
packages/
  contract/    OpenAPI 3.1 API contract
infra/         Future Google Cloud infrastructure configuration
```

See `CLAUDE.md` for team ownership and contribution rules.
