---
name: pr-readiness
description: Read-only readiness review of a pull request or branch (commits, changed files, CI on the exact head, tests, security, migrations, infrastructure, deployment and demo-data impact, docs and API contract) with an evidence ladder that never treats passing CI as deployment or QA. Never merges, pushes or deploys.
argument-hint: "[PR number | base..head] (default: current branch vs the default branch)"
disable-model-invocation: true
---

# PR readiness

Target: `$ARGUMENTS` (empty: the current branch compared with the default branch).

## Rules

- Read-only: fetch, read, and run local checks. Never merge, approve, push, rebase, comment, re-run or trigger CI, or change labels, settings, branch protection or rulesets. Never deploy. The merge decision belongs to the person `CLAUDE.md` names.
- Judge the exact head commit. CI results for any other commit do not count.
- Every statement cites evidence: commit SHA, file, CI run or job, test output. Anything not checked is written as `not verified`.
- No secrets in the report. Work in this session only: no subagents or background jobs.

## Steps

1. **Identify:** number, title, base branch and base SHA, head SHA, mergeable state; `git fetch`, then `git log --oneline <base>..<head>`.
2. **Changed files:** `git diff --stat <base>...<head>`, grouped as app code, tests, migrations and schema, API contract, CI workflows, infrastructure and deployment, dependencies and lockfiles, docs. Flag unintended changes: unrelated files, generated files without their source, secrets, large binaries, deleted, skipped or commented-out tests.
3. **CI:** every check run on the head SHA with its conclusion; checks that did not run, and whether they are required.
4. **Tests:** new behavior and its failure modes covered? Suites run locally (with counts)? Skipped tests are not passes.
5. **Security and compatibility:** authorization, validation and data exposure on changed routes (the user can run `/security-review` for a full review); API response and contract compatibility, version bump, generated client types.
6. **Database:** new migrations additive or destructive, locks on large tables, backfills, reversibility; schema and migrations in sync; behavior on existing data.
7. **Infrastructure and deployment:** which workflows run on merge (read their triggers); whether merging deploys; new environment variables, secrets, services, permissions or cost; rollback path.
8. **Demo and seed data:** do seed scripts, fixtures and existing demo records still work (schema changes, renamed fields, newly required data)?
9. **Docs and contract:** endpoints described in the API spec; generated types in sync; user and operator docs (`CLAUDE.md`, runbooks) updated when procedures change.

## Evidence ladder

Report each stage separately. Never infer a later stage from an earlier one: passing CI is not a deployment, a green deploy job is not a smoke test, a smoke test is not QA.

| Stage | Status (yes / no / partial / unknown) | Evidence |
| ----- | ------------------------------------- | -------- |
| Locally tested | | commands and counts |
| GitHub CI passed on head `<sha>` | | run and job links |
| Merged | | merge commit |
| Deployed | | deploy run for the merge commit, and its result |
| Functionally smoke-tested | | who, where, when, what |
| Manual QA completed | | tester, cases, recorded results |

## Output

### PR readiness: <PR or branch> (base `<sha>` → head `<sha>`)

**Verdict:** `Ready for a merge decision` or `Not ready` (list the blockers). This is a readiness assessment; nothing was merged or deployed.

Then one section per step with findings marked **Blocking**, **Should fix** or **Note**; the evidence ladder; and **Approvals needed before merging** (from `CLAUDE.md`: merge, deployment, cost).
