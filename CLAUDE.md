# CLAUDE.md — AcademiaPath

Bilingual (ES/EN) institutional LMS for a university in Peru. Customer demo deadline: **November 20, 2026**.
Technical lead: **Sagar Patel** (engineering, merge and release decisions).

## Mandatory Claude Code restrictions

1. NO subagents, Agent/Task delegation, agent teams or parallel agents.
2. NO automated agent workflows, background tasks, orchestration or autonomous execution loops.
3. Work directly in the current session with normal file/terminal tools only.
4. No Plan Mode and no unnecessary research.
5. Only inspect files relevant to the assigned task; do not repeatedly scan the repo or rerun commands without reason.
6. No extra documentation, unnecessary dependencies or complex frameworks unless requested.
7. Never provision cloud resources, deploy, run cloud jobs (migrations, seeds) or incur costs.
8. Never push, open or update pull requests unless explicitly asked. Never merge or deploy without Sagar's explicit authorization (see **Release policy**).
9. No Vertex AI or other external model or inference service for the current demo.
10. If a major error persists after two targeted correction attempts, stop and report it.
11. When the assigned task is complete, stop. Do not start another task.

## Architecture

- `apps/web` (Next.js) is presentation only. It must never contain secrets, authentication/authorization decisions, grading logic or AI calls.
- `apps/api` (Fastify, Node 22) owns all business logic: authentication, authorization, grading, tutoring, documents and any future integrations (SCORM, LTI: not built).
- API routes are versioned under `/api/v1`. Every endpoint must be described in `packages/contract/openapi.yaml` (OpenAPI 3.1); `pnpm contract:types` regenerates `packages/contract/generated/api.d.ts`.
- Persistence: PostgreSQL 16 with Drizzle ORM (backend only). Versioned SQL migrations live in `apps/api/drizzle/`; never edit an applied migration, add a new one.
- Learner helpers are deterministic, with no model inference: the guided tutor (AP-030D) quotes approved course content and is labelled "Mock AI — local demonstration"; the document summary (AP-014) is a labelled mock that quotes the document; study briefs (AP-031D) are extractive and labelled "not written by AI". Never present them as generative AI. A real AI tutor and generative summaries are deferred.
- Cloud demo (Google Cloud `elearning-514315`, `us-central1`): Cloud Run services `academiapath-web` and `academiapath-api`, Cloud SQL PostgreSQL 16 (`academiapath-db`), a Cloud Storage bucket for documents, Secret Manager for the database URL and demo credentials. See `infra/README.md`.
- `.github/workflows/deploy.yml` builds, migrates and deploys on every push to `main`: **merging is deploying**. `.github/workflows/pr-checks.yml` runs the quality gates on pull requests and never deploys. See `docs/release-quality-gates.md`.
- Secrets never go in the repo. `.env.example` holds non-secret examples only.

## People and ownership

| Person | Role | Paths |
| ------ | ---- | ----- |
| Sagar Patel | Technical lead: backend architecture, APIs, database, authentication, contract, infra; merge and release decisions | `apps/api/`, `packages/contract/`, `infra/`, root config |
| Havisha | Shared frontend UI components; manual QA for Student and Design Team | `apps/web/src/components/ui/` |
| Atharva | Course and student UI components and test data; manual QA for Instructor and Non-editing Instructor | `apps/web/src/components/courses/`, `apps/web/src/components/students/`, `apps/web/src/mocks/` |
| Claudio Obregón | Infrastructure and cloud cost | Approves anything that may increase GCP cost |

Changes outside your area (including `apps/web/src/app/`, root config and the contract) need technical-lead review. Sagar is not a manual QA tester; testers record the results they actually observed.

## Release policy

Claude may implement, review and test changes and commit them on a feature branch. Pushing, opening or updating a pull request needs an explicit request.

Before asking for a merge, Claude must:

- Review the complete diff and confirm the intended functionality.
- Check authorization and security boundaries.
- Run the relevant API and browser regression tests (synthetic data, local disposable PostgreSQL 16).
- Validate TypeScript, builds, the OpenAPI contract and contract types, and database migrations where applicable.
- Confirm no secrets or unrelated changes are included, and report test results accurately, including flaky tests.

If tests fail, material security findings remain open, migrations are destructive or unsafe, or important conflicts remain unresolved, Claude must stop and report the blocker.

Sagar's explicit authorization is required for every merge into `main` (it deploys), any deployment, cloud provisioning, paid services, production operations and irreversible production-data changes. Anything that may increase GCP cost also needs Claudio Obregón's approval. Claude must not claim that Sagar personally reviewed or approved changes unless he actually did.

The demo accounts (five roles), demo courses and their credentials in Secret Manager must not be changed, reset, rotated or read without explicit authorization. Never copy passwords into prompts, code, logs or commits.

## Commands (repo root)

- `pnpm install` — install dependencies
- `pnpm dev` / `pnpm dev:web` / `pnpm dev:api` — run locally (web :3000, API :4000)
- `pnpm typecheck` — type-check all workspaces
- `pnpm build` — build all workspaces
- `pnpm validate:openapi` — validate the OpenAPI spec; `pnpm contract:types` — regenerate the contract types
- `pnpm db:check` — validate the migration history; `pnpm db:generate` — create a migration after a schema change
- `TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres pnpm test` — API suite (local disposable PostgreSQL 16 only)
- `E2E_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres pnpm test:e2e` — Playwright browser suite on the production build (see `e2e/run.sh`)

Run `pnpm typecheck`, `pnpm build` and `pnpm validate:openapi` before committing; `pr-checks.yml` runs the same gates plus both test suites on every pull request.
