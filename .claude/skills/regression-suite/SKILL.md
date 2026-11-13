---
name: regression-suite
description: Run the repository's existing regression gates locally, the same ones its pull-request CI runs (typecheck, build, contract and schema checks, API and browser suites, localization and accessibility checks where configured), against disposable local data, and report actual counts. Never uses production data, secrets or cloud resources.
argument-hint: "[all | fast | api | browser] (default: all)"
disable-model-invocation: true
---

# Regression suite

Scope: `$ARGUMENTS`: `all` (default), `fast` (static gates only), `api` or `browser`.

## Rules

- Reuse the repository's own scripts, test runners and harnesses. Do not create a second test framework, add test dependencies, or edit, skip or weaken tests to get a pass.
- Databases: only a disposable local server (localhost, 127.0.0.1 or a unix socket) used for this run. Refuse any other database URL. Never use production or shared databases, cloud credentials or secret stores.
- Do not install software. If dependencies, a database server or browsers are missing, ask before running the repository's lockfile install; otherwise report that step as "not run" with the reason.
- Never push, merge, deploy, run cloud jobs (migrations, seeds) or trigger CI. Work in this session only: no subagents or background jobs.
- Report what actually ran in this session. Never reuse or estimate counts from earlier runs.

## 1. Discover the gates (do not guess)

Read `CLAUDE.md` (commands), the root and workspace package scripts, and the CI workflow that gates pull requests (a `.github/workflows/*` file triggered by `pull_request`). That workflow is the reference: run its commands locally in the same order. Note which steps need a database URL, ports, a production build or browsers, and how the repository provides them (test helpers, runner scripts).

## 2. Prepare

- Record the commit under test; `git status --short` must be clean or the dirty files listed.
- Disposable database: an existing local server, or one started in a temporary directory. Prefer the repository's harness (helpers that create and drop a database per test file; runner scripts that create and drop their own).
- If a suite silently skips database tests when a variable is unset, set it: skipped tests are not passes.

## 3. Run

Map each gate to the repository's actual command (for `fast`, steps 1–5 only):

1. Frozen lockfile install (only if needed, with approval).
2. Typecheck.
3. API contract validation, and generated types in sync (regenerate, then `git diff --exit-code` on the generated files).
4. Migration history and schema checks (generation must produce no new migration).
5. Production build.
6. Full API or integration suite against the disposable database.
7. Browser suite through the repository's runner (production build, its own database and seed).
8. Localization checks (catalog parity, hardcoded-text guards, locale tests) if configured.
9. Accessibility checks only if a committed suite runs them (e.g. axe tests run by the repository's scripts or CI). Otherwise report `not configured`: checks run ad hoc or in scratch files, or only mentioned in PR descriptions, are not coverage. Do not add a suite.

Run every gate even after a failure, unless the user asked to stop at the first. Afterwards confirm that no test databases or servers are left and tracked files are unchanged.

## 4. Failures

For each failure: gate, test name, `file:line` if shown, the first error lines, and whether it reproduces when that test file is re-run once. A failure that passes on re-run is reported as **flaky**, never hidden. Do not modify code; propose a fix.

## Output

### Regression suite: `<commit>` (<date>)

| Gate | Command | Result | Tests / pass / fail / skipped | Duration |
| ---- | ------- | ------ | ----------------------------- | -------- |

Then: failures, flaky tests, gates not run (and why), environment (runtime, package manager and database versions), cleanup confirmation.
