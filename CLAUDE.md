# CLAUDE.md — AcademiaPath

Bilingual (ES/EN) institutional LMS for a university in Peru. Customer demo deadline: **November 13, 2026**.

## Mandatory Claude Code restrictions

1. NO subagents, Agent/Task delegation, agent teams or parallel agents.
2. NO automated agent workflows, background tasks, orchestration or autonomous execution loops.
3. Work directly in the current session with normal file/terminal tools only.
4. No Plan Mode and no unnecessary research.
5. Only inspect files relevant to the assigned task; do not repeatedly scan the repo or rerun commands without reason.
6. No extra documentation, unnecessary dependencies or complex frameworks unless requested.
7. Never provision cloud resources, deploy, or incur costs.
8. Never push to GitHub unless explicitly asked.
9. If a major error persists after two targeted correction attempts, stop and report it.
10. When the assigned task is complete, stop. Do not start another task.

## Architecture rules

- `apps/web` (Next.js) is presentation only. It must never contain secrets, authentication/authorization decisions, grading logic or AI calls.
- `apps/api` (Fastify) owns all business logic: authentication, authorization, grading, AI tutoring, integrations (SCORM, LTI).
- API routes are versioned under `/api/v1`. Every endpoint must be described in `packages/contract/openapi.yaml` (OpenAPI 3.1).
- Future persistence: PostgreSQL with Drizzle ORM (backend only). Future cloud: Google Cloud (`infra/`).
- Secrets never go in the repo. `.env.example` holds non-secret examples only.

## Ownership

| Owner   | Area | Paths |
| ------- | ---- | ----- |
| Sagar Patel (project owner) | Backend architecture, APIs, database, authentication, integrations, contract, infra | `apps/api/`, `packages/contract/`, `infra/`, root config |
| Havisha | Beginner-friendly shared frontend UI components | `apps/web/src/components/ui/` |
| Atharva | Beginner-friendly course and student UI components, plus test data | `apps/web/src/components/courses/`, `apps/web/src/components/students/`, `apps/web/src/mocks/` |

Changes outside your area (including `apps/web/src/app/`, root config and the contract) need technical-lead review. For Claude Code pull requests, the standing authorization in **Development review policy** replaces individual approval comments from Sagar.

## Development review policy

Claude Code is authorized by Sagar Patel to implement, review, test and merge routine AcademiaPath development pull requests without individual manual approval comments, provided all applicable quality and security checks pass.

This authorization applies exclusively to local development using synthetic data.

Before merging any feature, Claude must:

- Review the complete diff.
- Confirm the intended functionality.
- Check authorization and security boundaries.
- Run relevant API and browser regression tests.
- Validate TypeScript and builds.
- Validate OpenAPI contracts.
- Validate database migrations where applicable.
- Confirm no secrets or unrelated changes are included.
- Respect all actual GitHub branch protections.

Claude must not claim that Sagar personally reviewed or approved changes unless he actually did.

If tests fail, material security findings remain open, migrations are destructive or unsafe, or important conflicts remain unresolved, Claude must stop and report the blocker.

Sagar's explicit approval remains mandatory for cloud provisioning or deployment, paid services, production operations, irreversible production-data changes and production releases.

## Commands (repo root)

- `pnpm install` — install dependencies
- `pnpm dev` / `pnpm dev:web` / `pnpm dev:api` — run locally (web :3000, API :4000)
- `pnpm typecheck` — type-check all workspaces
- `pnpm build` — build all workspaces
- `pnpm validate:openapi` — validate the OpenAPI spec

Run `pnpm typecheck`, `pnpm build` and `pnpm validate:openapi` before committing.
