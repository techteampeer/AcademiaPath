---
name: security-review
description: Structured, evidence-based security review of a branch, diff or path. Reports confirmed vulnerabilities separately from speculative risks, each tied to real files and lines. Read-only; never edits code, pushes, merges or deploys.
argument-hint: "[base..head | path | PR number] (default: current branch vs the default branch)"
disable-model-invocation: true
---

# Security review

Scope: `$ARGUMENTS` (empty: the current branch compared with the default branch).

## Rules

- Read-only. Do not edit, stage or commit repository files, push, comment on GitHub, merge or deploy. Report; the user decides what to fix.
- Evidence or it is not a finding: every item cites `path:line` and the code or command output that shows it.
- Never read, print or copy secret values (env files, credential stores, cloud secrets). Report an exposed secret by its location, not its value.
- Never probe deployed or shared environments. Reproduce only locally, against disposable data, with the repository's own commands. Temporary probe scripts go in a scratch directory outside the repository and are deleted afterwards.
- Do not install tools or dependencies for the review. Work in this session only: no subagents or background jobs.

## Prepare

1. Read the repository's `CLAUDE.md` (or README/CONTRIBUTING) for architecture boundaries, roles and security rules.
2. Fix the scope: `git fetch`; record the base and head commits; read `git diff --stat <base>...<head>` and the full diff.
3. List the trust boundaries the change touches: routes and handlers, auth middleware, data access, rendering, file handling, configuration, CI, dependencies.

## Checklist (changed code and the code it calls)

1. **Authentication and sessions:** protected routes require authentication; cookie flags (HttpOnly, Secure, SameSite); expiry, logout and revocation; no tokens in URLs, logs or browser storage.
2. **Authorization:** role and resource checks on every read and write; IDs from the request are never trusted; hidden, draft or unpublished data stays hidden; no cross-tenant or cross-resource access; denials follow the codebase's convention (e.g. 404 instead of revealing existence).
3. **CSRF and Origin:** state-changing requests require the project's CSRF token and Origin checks; nothing changes state on GET.
4. **Input validation:** schemas at the boundary (types, lengths, enums, sizes); uploads (content sniffing, size and archive limits); pagination and limits.
5. **Injection and rendering:** SQL only through the query builder or parameters; no raw HTML from user or document content (`dangerouslySetInnerHTML`, `innerHTML`), safe URL schemes; SSRF (no server-side fetch of user-supplied URLs without an allowlist); path traversal; shell execution; unsafe deserialization; regexes vulnerable to catastrophic backtracking on untrusted input.
6. **Information leakage:** errors, logs and API responses expose no hashes, storage paths, secrets or other users' data beyond the API contract; private responses are not cacheable.
7. **Secrets and credentials:** none committed (code, fixtures, docs, CI files); CI tokens and service accounts have least privilege; examples use placeholders.
8. **Database access and isolation:** queries scoped to the authorized user, tenant or resource; transactions where invariants span rows; migrations do not weaken constraints or silently drop data.
9. **Dependencies:** new or upgraded packages in manifests and lockfiles: necessity, maintainer and popularity, install scripts, pinned versions, typosquatting. Prefer no new dependency.

## Classify

- **Confirmed:** demonstrated by a local probe or test you ran, or by an unambiguous code path traced end to end (state the path).
- **Speculative:** plausible but not demonstrated; state what evidence would confirm or dismiss it.
- **Severity:** Critical, High, Medium, Low or Info, with a one-line justification.

## Output

### Security review: <scope> (base `<sha>` → head `<sha>`)

| # | Status | Severity | Category | Location | Finding | Evidence | Recommended fix |
| - | ------ | -------- | -------- | -------- | ------- | -------- | --------------- |

Then:
- **No issue found:** the checklist numbers checked with nothing to report.
- **Not reviewed:** what was out of scope or could not be checked, and why.
- **Verdict:** `No blocking findings` or `Blocking findings: #…` (Confirmed High or Critical). No code was changed.
