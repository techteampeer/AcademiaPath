# Release quality gates

`main` deploys itself: every push to `main` runs `.github/workflows/deploy.yml`, which builds, migrates and deploys to
Cloud Run. The pull request checks below exist to catch broken code **before** it reaches `main`.

## What runs on every pull request into `main`

`.github/workflows/pr-checks.yml`, one job named **Quality gates** (about 8–12 minutes), on the pull request's merge
result:

| Step | Local command | Fails when |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | TypeScript errors in the API or the web app |
| Validate OpenAPI | `pnpm validate:openapi` | `packages/contract/openapi.yaml` is invalid |
| Contract types | `pnpm contract:types`, then commit | `generated/api.d.ts` does not match `openapi.yaml` |
| Migrations and schema | `pnpm db:check`; `pnpm db:generate` | Broken migration history, or a schema change without a committed migration |
| Production build | `pnpm build` | The API or the web app does not build |
| API suite | `TEST_DATABASE_URL=… pnpm test` | Any API, authorization, CSRF/Origin or migration test fails |
| Browser suite | `E2E_PG_ADMIN_URL=… pnpm test:e2e` | Any Playwright test (EN/ES, five roles, features) fails |

The database is a throwaway PostgreSQL 16 container on the runner, and every test credential is synthetic and generated
per run. The workflow has a read-only token, uses no secrets and has no Google Cloud access, so it cannot deploy,
migrate or read the demo database. A new push to the same pull request cancels the superseded run.

## When a check fails

1. Open the failed run and the first red step; its name says which gate failed.
2. Reproduce it locally with the command above (local disposable PostgreSQL 16 only).
3. Fix the cause in the pull request. Never skip, weaken or delete a test, or disable a check, to get a green run.
4. A failure that passes on "Re-run failed jobs" is a flaky test: report it as such in the pull request and fix it
   separately; do not ignore a failure that reproduces.

This repository is public, so run logs are public: never print secrets or demo passwords in tests or scripts.

## What needs a person

| Action | Who decides |
| --- | --- |
| Merging into `main` (this deploys) | Sagar Patel, explicitly, even when every check is green |
| Any deployment, cloud job (migrate, seed), Cloud Run or Cloud SQL change | Sagar Patel |
| Anything that may increase GCP cost | Claudio Obregón, plus Sagar Patel |
| Changing demo accounts, demo data or their credentials | Sagar Patel |
| Activating these checks or the ruleset below | Sagar Patel |

Green checks prove the code builds and passes the test suites on synthetic data. They do not prove the cloud
configuration, secrets, the real demo database, IAM or cost are right, which is why deployment stays separately
authorized.

## Protecting `main` with a ruleset

Without protection anyone with write access can push to `main` and deploy untested code. A ruleset that requires a
pull request and a passing **Quality gates** check closes that path.

Activate in this order, or the repository can lock itself:

1. Merge `pr-checks.yml` into `main` (authorized merge). Note: like any push to `main`, this merge also runs
   `deploy.yml` and redeploys the unchanged application.
2. Open a pull request and confirm a check named **Quality gates** appears and passes.
3. Only then, in **Settings → Rules → Rulesets → New ruleset → New branch ruleset**:
   - Target: *Include default branch*. Enforcement: *Active*.
   - *Restrict deletions* and *Block force pushes*.
   - *Require a pull request before merging*. Required approvals: 0 while all pull requests come from one shared
     account (an author cannot approve their own pull request); 1 once team members use personal accounts.
   - *Require status checks to pass*: add **Quality gates** (source: GitHub Actions), picked from the list.
   - Leave *Require branches to be up to date* off for now (it re-runs checks after every merge).
   - Bypass list: none. If an emergency path is needed, add the admin role *for pull requests only* and use it
     only with Sagar's decision.

Avoid lock-ins: a required check that never reports leaves every pull request "waiting for status" and blocks all
merges. That happens if the check is required before it has ever run, if the job is renamed (the required name must
match exactly), if the workflow is disabled, or if path filters or conditions skip it. `pr-checks.yml` therefore has
no path filters. To rename the job, update the ruleset in the same change.

## After every deployment

1. The `Deploy to Cloud Run (demo)` run for the merge commit is green (it checks `/api/v1/health` and `/login`).
2. Sign in on both web URLs (the `run.app` URL printed by the deploy run and the alternate `*.a.run.app` URL).
3. Manual QA on the changed feature and the main paths, in English and Spanish: Havisha (Student, Design Team),
   Atharva (Instructor, Non-editing Instructor); administrator cases only with explicit authorization.
4. Testers record the results they actually observed in the QA sheet. A green deployment is not functional acceptance.
5. If something is broken, report it to Sagar. Rolling back (a revert merge or moving Cloud Run traffic) is itself a
   deployment and needs his authorization.
