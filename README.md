# AcademiaPath

Bilingual (Spanish/English) institutional learning management system for a university in Peru.

## Stack

| Area      | Technology                                          |
| --------- | --------------------------------------------------- |
| Monorepo  | pnpm workspaces                                     |
| Frontend  | Next.js (App Router) + TypeScript + Tailwind CSS    |
| Backend   | Fastify + Node.js + TypeScript                      |
| Contract  | OpenAPI 3.1 (`packages/contract/openapi.yaml`)      |
| Planned   | PostgreSQL + Drizzle ORM, Google Cloud              |

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
