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
| `pnpm db:seed:dev`      | Create synthetic local users (dev only)  |
| `pnpm db:seed:demo`     | Seed the synthetic demo courses (dev only) |

## Database

The schema lives in `apps/api/src/db/schema/`; versioned SQL migrations live in `apps/api/drizzle/`.

1. Use a local PostgreSQL 16 server (never the institutional database) and create a database, e.g. `createdb academiapath_dev`.
2. Set `DATABASE_URL` in the root `.env` (see `.env.example`). Credentials belong only in your uncommitted `.env`.
3. Apply migrations: `pnpm db:migrate`.

After changing the schema, run `pnpm db:generate`, review the generated SQL and commit it together with the schema change.

## Authentication

Email/password sign-in with server-side sessions stored in PostgreSQL (`POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/csrf`, `GET /api/v1/me`; see `packages/contract/openapi.yaml`). The session token lives only in an HttpOnly cookie; state-changing requests must send the `X-CSRF-Token` returned at sign-in. Authentication settings are listed in `.env.example`.

User accounts: administrators manage accounts under **Administration → Users** (`/admin/users`; API `GET/POST /api/v1/users`, see the contract). They can search and page through users, create accounts with initial course roles, edit names and the system role, deactivate (which ends every session at once) and reactivate accounts, change course roles and enrollment status, and bulk-enroll existing accounts as students from a CSV with a preview. New accounts have no password: the person chooses one through a single-use, expiring activation link (`/activate#token=…`; only a SHA-256 hash of the token is stored). With `ACCOUNT_INVITATION_DELIVERY=local_link` (the development default) the administrator sees the link once, for synthetic addresses such as `@academiapath.example` only; production refuses this mode and issues no links until secure delivery and identity verification exist. The last active administrator can never be deactivated or demoted. There is no SSO and no password reset yet.

For local testing, `pnpm db:seed:dev` creates synthetic users (`admin@`, `instructor@`, `student@`, `reviewer@` and `ta@academiapath.example`) with the password from `DEV_SEED_PASSWORD`. Course roles (for example design team for `reviewer@`) are assigned per course in Academic setup. It refuses to run in production or against a non-local database.

## Frontend and API integration

The browser only calls `/api/*` on the web origin; Next.js forwards it to the API (`apps/web/next.config.ts`, target `API_ORIGIN`, default `http://127.0.0.1:4000`). The session stays in the HttpOnly cookie, and the web app keeps the CSRF token in memory only.

API types for the web app are generated from the contract: after changing `packages/contract/openapi.yaml`, run `pnpm contract:types` and commit `packages/contract/generated/api.d.ts`.

Course content: instructors add plain-text lessons and links to a course's sections and submit them for review; the design team approves or returns them with comments. Students only see approved versions; editing approved content creates a revision that stays hidden until it is approved.

Course documents (proof of concept): instructors and the design team upload PDF, Word (.docx) or PowerPoint (.pptx) files in a course's **Document library**. The API checks each file's real content (signature and container structure), refuses encrypted, macro-enabled, malformed and oversized files, extracts the selectable text in a time- and memory-limited worker thread (no OCR, so scanned pages yield no text) and creates a deterministic **mock** summary that only quotes sentences from the document, with page, slide or paragraph references. **Refresh summary** adds a new revision; documents and summaries go through the same review as other content, and students only ever see the approved document and summary revision. Original files are stored privately outside the repository (`DOCUMENT_STORAGE_DIR`, default `~/.academiapath/documents` in development) under server-generated names and are only downloadable through the authenticated, course-authorized API. **No malware scanning service is connected** (uploads are recorded as `not_scanned`; `apps/api/src/documents/scanner.ts` is the integration hook), so this local proof of concept is not approved for untrusted production documents.

Local demo: start PostgreSQL, run `pnpm db:migrate` and `pnpm db:seed:dev`, then `pnpm dev` and open http://localhost:3000/login. Administrators get **Academic setup** (`/admin/setup`); everyone gets **Dashboard** (`/dashboard`).

Demonstration dataset: `pnpm db:seed:demo` adds three synthetic courses (ITIL 4 Foundation, Project Management Fundamentals, Introduction to Artificial Intelligence) with content, review states, quizzes, assignments, grades and documents, created through the real API as the seeded accounts. It is repeatable, never deletes data and is for local databases only. See `docs/demo-walkthrough.md` for the accounts and the step-by-step demo.

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
