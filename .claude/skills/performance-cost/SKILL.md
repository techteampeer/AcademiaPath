---
name: performance-cost
description: Measure the performance and cloud-cost impact of a change (response times, query counts and N+1, large-input scaling, CPU and memory, bundle size, request volume, managed runtime and database implications, new billable services and external APIs) using real local measurements only. No paid cloud operations or infrastructure changes.
argument-hint: "[base..head | path | endpoint] (default: current branch vs the default branch)"
disable-model-invocation: true
---

# Performance and cost review

Scope: `$ARGUMENTS` (empty: the current branch compared with the default branch).

## Rules

- Measure, do not estimate. Every number comes from a command run in this session; state the command, input, number of runs and statistic (median, p95). If something could not be measured, write `not measured` and why. Never invent or round figures in your favor.
- Local and disposable only: local builds and servers, disposable databases, synthetic data. No load tests or benchmarks against deployed environments, no cloud commands that create, change or bill resources, no paid APIs.
- Do not change application code or infrastructure. Prefer the repository's own benchmarks; otherwise put probe scripts in a scratch directory outside the repository and delete them afterwards.
- No new dependencies or tool installs. Work in this session only: no subagents or background jobs.

## Measure (only what the change touches; base and head when both are relevant)

1. **API response time:** the changed endpoints on a local server or in-process harness; median and p95 over at least 9 runs.
2. **Database queries:** queries per request (test harness, ORM logging, or temporary statement logging on the disposable server). N+1: query count grows with list size; measure at two sizes.
3. **Large inputs:** increasing sizes (e.g. 1×, 4×, 16×) up to the documented limits. Flag superlinear growth, missing or unenforced limits, and CPU-bound work on the request thread (event-loop blocking).
4. **Memory:** peak heap or RSS for the largest supported input; full buffering versus streaming.
5. **Browser:** production build output per route, before and after; new client-side dependencies; requests per page load and polling (use existing request-budget tests if present).
6. **Managed runtime (e.g. Cloud Run):** read the deploy configuration only (workflow, IaC): CPU, memory, minimum and maximum instances, concurrency, timeouts. Explain how the change affects CPU time per request, cold starts or instance count.
7. **Managed database (e.g. Cloud SQL):** connection pool size against instance limits, new indexes and storage growth, long or locking queries, migrations on large tables.
8. **New billable services:** new cloud APIs, buckets, queues, schedulers, secrets, log volume or egress introduced by the change.
9. **External APIs:** new outbound calls, per-call pricing, rate limits, required keys, behavior when the service is unavailable.

## Output

### Performance and cost: <scope> (base `<sha>` → head `<sha>`)

| Area | Method (command, input, runs) | Before | After | Change | Verdict |
| ---- | ----------------------------- | ------ | ----- | ------ | ------- |

Then:
- **Risks** with evidence.
- **Cost implications:** `none found` or `possible increase` (what and why).
- **Not measured:** what, and why.
- **Approvals needed:** any cost increase goes to the approvers named in `CLAUDE.md` before merge.
