# AcademiaPath — Technical Handoff for Claudio

| | |
|---|---|
| Date | 4 November 2026 (demo deadline: 13 November 2026) |
| Repository | `techteampeer/AcademiaPath`, `main` at `87e39c4` |
| Scope | Local MVP, tasks AP-001 to AP-011. Nothing has been deployed; no cloud resources exist. |
| Data | Synthetic only. No institutional data, production credentials or paid services were used. |

This report summarises what exists and how it was verified, and lists what Claudio needs to decide. **The original specification is not complete.** Section 6 lists the gaps. That list is based on the task briefs and `CLAUDE.md`; the original specification document is not stored in this repository.

---

## 1. Completed functionality

**Architecture:**
- pnpm monorepo.
- `apps/web`: Next.js 16 / React 19 / Tailwind 4. Presentation only.
- `apps/api`: Fastify 5 with all business logic.
- `packages/contract`: OpenAPI 3.1 contract with generated TypeScript types.
- PostgreSQL 16 accessed through Drizzle ORM; 11 versioned migrations (`0000`–`0010`).
- Browser requests go through a same-origin Next.js proxy (`/api/*`) to the API.

| Area | Status | What exists (evidence) |
|---|---|---|
| Architecture & database | **Implemented** | Monorepo, API versioned under `/api/v1`, contract-first (45 operations, contract v0.7.0). The database enforces integrity with checks, composite foreign keys, uniqueness, an append-only `audit_log`, and immutability triggers for submitted quiz attempts and assignment submissions. |
| Authentication | **Implemented (local)** | Email and password (Argon2id). Server-side sessions in PostgreSQL. HttpOnly cookie (`__Host-` prefix in production). CSRF token (HMAC of the session token) plus Origin check. Login rate limit. RFC 9457 errors. |
| RBAC | **Implemented** | `administrator` is the only system role. Course roles are `design_team`, `instructor`, `non_editing_instructor` and `student`. Access is denied by default, and cross-course access returns 404. Student-only and grader-only actions (taking quizzes, submitting work, grading, releasing grades, using the tutor) check the course role only; the administrator override never grants them. |
| User accounts | **Partial** | No API or UI to create or manage users. Accounts come only from the local seed script (`pnpm db:seed:dev`). No password reset, no SSO. |
| Academic management & enrollments | **Implemented / Partial** | Programs, terms, versioned course templates (sections with visibility), courses and enrollments: API plus admin setup UI (`/admin/setup`). **Missing:** editing a course after creation (including publishing a draft), managing sections, toggling visibility, removing enrollments. |
| Content authoring & approval | **Implemented** | Lessons (plain text), external links, quizzes and assignments share one review workflow: draft → submitted → approved / returned. Students only ever see the approved copy. Editing approved content creates a hidden revision. Self-approval is refused. |
| Quizzes & server-side grading | **Implemented** | Single answer, multiple answer (exact match) and true/false questions. Order is fixed per attempt. Attempt limits and server-clock time limits are enforced in PostgreSQL. Grading is server-side only. Answer keys never reach students, the audit log or the web bundles. |
| Assignments, gradebook & release | **Implemented** | Text submissions with a due date and late window. Points-based rubric grading by instructors and non-editing instructors. Gradebook: quizzes count the best attempt, scale 0–20 rounded half up to one decimal, course total is the unweighted sum of points. Release is explicit and audited; students see only released grades. |
| Course-grounded tutor | **Mock** | Real retrieval with course-level authorization over approved lessons only (PostgreSQL full-text search). Real citations, English and Spanish templates, practice prompts, usage accounting and rate limits. **The responses come from a deterministic local mock provider, labelled "Mock AI — local demonstration". No language model is used.** |
| Bilingual UI (ES/EN) | **Partial** | Only the tutor page has English and Spanish interface strings. Everything else is in English. Content can be written in any language. |
| Demo UI previews | **Mock** | `/preview/courses` shows UI components with static synthetic data from AP-004. |

### PR and commit references

| Task | Delivered in | Merge / commit on `main` |
|---|---|---|
| AP-001 monorepo foundation | Initial commit (pushed during the authorized GitHub bootstrap) | `143baed` |
| AP-002 foundational schema | Commit (pushed during the authorized GitHub bootstrap) | `cff2ec3` |
| AP-003/004 app shell & course UI | PR #1 | `61472c4` |
| AP-005 authentication | PR #2 | `62c9a95` |
| AP-006 academic structure & enrollment APIs | PR #3 | `cce9711` |
| AP-007 frontend ↔ API integration | PR #4 | `50ec4eb` |
| AP-008 content & review approval | PR #5 | `c908286` |
| AP-009 quizzes (includes fix `e3af00b`: no answer keys in the audit log) | PR #6 | `654aa3a` |
| AP-010 assignments, gradebook, release | PR #7 | `237d956` |
| AP-011 course-grounded mock tutor | PR #8 | `87e39c4` |

---

## 2. Verification evidence

All results below were taken at `94988ab` (PR #8 head). After the merge, `main` (`87e39c4`) has the identical file tree.

| Check | Result |
|---|---|
| API tests | **169 / 169 passed** (20 suites, `node:test`). Run against a disposable local PostgreSQL 16 with a fresh migrated database per test file. Covers auth, courses, content review, quizzes, gradebook, tutor, migrations and schema. |
| Browser journeys (real Chromium, built web + API, freshly migrated DB) | **3 / 3 passed:** quiz authoring → review → attempt → results; assignment → grading → release → student grades; student tutor (EN/ES, citations, insufficient-material answers, practice prompts). 0 console errors. 0 external network requests from the tutor page. Answer-key and feedback markers never reached the student or the bundles. |
| TypeScript / builds | `pnpm typecheck` and `pnpm build` pass (web and API). |
| OpenAPI | Contract v0.7.0 is valid (OpenAPI 3.1, 45 operations). The generated TypeScript types match the contract. |
| Migrations | `drizzle-kit check` passes, a drift probe generates no new migration, and a fresh database migrates cleanly in every browser run. |
| Security checks done | Tests for authorization, cross-course isolation, CSRF and Origin, and every role. Concurrency tests (attempt limits, submissions, grading, release). Leak checks on API responses and built bundles for answer keys and unreleased grades. Audit-log scans for secrets and answer keys. Tutor code scanned for network calls, model calls and logging (none). Every diff scanned for secrets before commit. |

### Untested or not yet verified

- **No CI pipeline.** All checks were run manually. The browser journeys are scratch Playwright scripts and are **not committed**.
- No penetration test, dependency vulnerability audit (`pnpm audit` was not run), load or performance test, or formal WCAG accessibility audit.
- Chromium only; no Firefox or Safari testing. Responsive layout was spot-checked in AP-007.
- The admin setup UI was browser-verified in AP-007. The final journeys created data through the API, so they did not repeat it.
- Behaviour with multiple instances has been reviewed in the code but not tested (see §4).

---

## 3. Demo walkthrough (local, synthetic accounts)

**Prerequisites:** Node.js 22.19+, pnpm 10 (`corepack enable`), local PostgreSQL 16, a Chromium-based browser.

```bash
pnpm install
cp .env.example .env
```

Edit `.env`: set `DATABASE_URL` to a **local** database (for example `postgresql://localhost:5432/academiapath_dev`) and set `DEV_SEED_PASSWORD` to a local-only value of at least 12 characters. Never commit `.env`.

```bash
createdb academiapath_dev
pnpm db:migrate
pnpm db:seed:dev
pnpm dev
```

`pnpm db:seed:dev` creates admin@, instructor@, student@ and reviewer@academiapath.example. `pnpm dev` starts the web app on http://localhost:3000 and the API on :4000.

**Sample data:** there is no course-content seed script. Steps 1–2 create the course and content through the UI (about 10 minutes); preparing them before the meeting is recommended. There are only four seeded accounts, so the **non-editing instructor** role cannot be shown without another account. API tests cover that role.

| # | Account | Steps | Point out |
|---|---|---|---|
| 1 | **Administrator** (`admin@`) | Academic setup (`/admin/setup`): create a program and a term. Create a template with sections, for example "Unidad 1" plus one section marked hidden. Create a course with status **Published**. Enroll `instructor@` as Instructor, `reviewer@` as Design team and `student@` as Student. | Admins manage structure; the administrator role grants no grading or tutor access. |
| 2 | **Instructor** (`instructor@`) | Course → Add content: a text lesson in English and one in Spanish, a quiz (settings, then add single, multiple and true/false questions with answers), and an assignment (instructions, due date, rubric). Submit each for review. | No Approve button for the author. Answer keys are visible only to staff. |
| 3 | **Design team** (`reviewer@`) | Course → review queue → approve the lessons, quiz and assignment. Optionally return one with a comment. | Students only ever see approved copies. |
| 4 | **Student** (`student@`) | Read a lesson. Take the quiz: the confirmation shows no score. Submit the assignment once. My grades shows everything as **pending**. | Server timer and attempt limit; no answer keys; one final submission. |
| 5 | **Instructor** | Assignment → Grade with the rubric → **Release assignment grades**. Quiz → **Release quiz grades**. Open the Gradebook. | The server computes grades on the 0–20 scale. The best quiz attempt counts. Release is explicit and audited. |
| 6 | **Student** | My grades: released scores, rubric breakdown and feedback, course total. | Unreleased items show no numbers. |
| 7 | **AI Tutor** (as Student) | Course → Tutor. Ask in English about a lesson and follow the citation link. Switch to Español and ask again. Ask something not covered ("insufficient material"). Request practice prompts. | **Mock AI — local demonstration**: answers quote approved lessons only, sources in another language are labelled and not translated, and no AI service is called. |

---

## 4. Google Cloud architecture recommendation (not provisioned)

This is a proposal that fits the current codebase. Every item needs Claudio's approval (§7).

| Component | Recommendation | Codebase notes and requirements |
|---|---|---|
| Web & API hosting | Two **Cloud Run** services (web and API), images in Artifact Registry. A global external **Application Load Balancer** on one domain routes `/api/*` to the API and everything else to the web. | Keep a single origin: the `__Host-` cookie and the Origin/CSRF checks expect it. Set `APP_ORIGINS` to the public origin and `NODE_ENV=production`. |
| PostgreSQL | **Cloud SQL for PostgreSQL 16**, private IP. Regional high availability for production. Run migrations as a **Cloud Run job** (`pnpm db:migrate`) before each release. | Size the `pg` pool against Cloud Run maximum instances so the total stays below Cloud SQL `max_connections`. |
| Authentication & sessions | Keep server-side sessions in PostgreSQL; they work across instances. Add **institutional SSO** (OIDC or SAML through the university's identity provider) and user provisioning. | **The login rate limiter is in-memory per instance** (`@fastify/rate-limit` default store). It must move to a shared store (a PostgreSQL table or Memorystore) and/or Cloud Armor rate-based rules. `TRUST_PROXY` must list the verified proxy ranges of the chosen ingress. The CSRF token (HMAC keyed by the session token) and the tutor limit (counted in PostgreSQL) already work across instances. |
| Secret management | **Secret Manager**, exposed to Cloud Run as environment variables or mounted secrets. One service account per service with least privilege. Optionally Cloud SQL IAM database authentication. | No secrets in the repository (`.env.example` holds non-secret values only). The dev seed refuses production. |
| TLS & domain | Google-managed certificates on the load balancer and a university (sub)domain. Add HSTS and review the Content-Security-Policy. | Security headers have not been audited yet. |
| Logging & monitoring | Cloud Logging (structured Fastify logs; `LOG_LEVEL`), Error Reporting, Cloud Monitoring uptime checks on `/api/v1/health`, alerting policies. | Keep personal data and tokens out of logs (no secrets were found in local logs). The business audit trail stays in `audit_log`. |
| Backups & recovery | Cloud SQL automated backups with **point-in-time recovery**. Define RPO and RTO, test restores regularly, and optionally export to Cloud Storage. | The audit log is append-only by design; plan its retention. |
| Data protection | Choose the region for data residency (candidates include `southamerica-west1`, Santiago; confirm requirements). Default encryption at rest (CMEK optional). Private database, no public IP. Retention policies for sessions, tutor usage and audit data. | Confirm the applicable personal-data rules with legal (for example Peru's Ley N.º 29733). |
| Scaling & security | Cloud Run autoscaling with minimum and maximum instances. **Cloud Armor** (WAF and rate limits). CI/CD on Cloud Build or GitHub Actions: typecheck, tests against a disposable Postgres, build, OpenAPI validation, dependency and container scanning. | No CI exists today, and GitHub Actions files were intentionally not created; needs a decision. |

**Cost categories (no estimates without approval):** Cloud Run compute and minimum instances, Cloud SQL instance, storage, high availability and backups, load balancer and Cloud Armor, Secret Manager, logging and monitoring volume, network egress, CI build minutes.

---

## 5. Replacing the mock with a real course-grounded model

| Topic | What must change |
|---|---|
| Provider abstraction | Implement the existing `TutorProvider` interface (`apps/api/src/tutor/provider.ts`) for the approved vendor. Add a new `provider.mode` value in the contract, extend the `tutor_usage.provider_mode` check with a migration, select the provider through configuration, and keep the mock for tests. The API and UI shapes already carry `provider`, `grounding` and `citations`. |
| Grounded retrieval | Store passages with a `tsvector` column and GIN index (today the search vector is computed on every request). Use language-aware dictionaries. Optionally add semantic search (for example pgvector on Cloud SQL) for hybrid ranking. Add bounded context-window assembly. The existing authorization filters (approved copies, visible sections, one course) must stay in front of everything. |
| Citation verification | Require structured output (answer plus cited reference numbers). On the server, reject or repair any reference not among the supplied passages and any quotation not found verbatim. If it isn't grounded, return the insufficient-material answer. |
| Bilingual support | The model answers in the requested language. Quotations stay in their original language and are labelled; any translation must be marked as machine-generated. Evaluate both languages separately. |
| Model evaluation | Before launch, run a per-course golden set of English and Spanish questions measuring citation precision, faithfulness, correct refusals, prompt-injection and jailbreak resistance, answer-key and grade leakage, latency and cost per request. Add instructor review of samples and regression runs on every prompt or model change. |
| Security & privacy risks | Student questions are personal data. Required: a data-processing agreement and no training on customer data, data residency, retention limits, PII minimisation (no names or emails in prompts, already true for the mock), prompt injection from course content, output filtering, abuse and rate limits, per-course quotas, and academic-integrity policy (the tutor must not solve graded assessments). |
| Operating-cost categories | Model input and output tokens, embeddings, vector storage and indexing, extra database load, evaluation runs, logging and monitoring, human review time. |
| Required approvals | Vendor and contract (including the DPA), budget and quota caps, legal and data-protection review, academic policy (use on graded work), a per-course opt-in for instructors, and Claudio's sign-off before any external call. |

---

## 6. Outstanding scope

This classification is a **proposal for Claudio to confirm**.

| Gap | Category |
|---|---|
| Institutional SSO and user provisioning; account lifecycle (create, deactivate, password reset) | Required before production |
| Full Spanish/English interface localization (only the tutor is bilingual today) | Required before production |
| Course administration: edit or publish a course after creation, manage sections and visibility, reorder or delete activities, remove enrollments | Required before production |
| Shared login rate limiting and proxy trust configuration for multiple instances | Required before production |
| CI/CD with committed browser tests; dependency and container scanning | Required before production |
| GCP environment, secrets, backups, monitoring, TLS and domain (`infra/` is empty) | Required before production |
| Security review or pentest, security headers, WCAG accessibility audit | Required before production |
| Data retention and privacy policy (sessions, tutor usage, audit log) | Required before production |
| SCORM and LTI integrations (activity types exist in the schema; not implemented) | Required for later scope acceptance |
| File activities and uploads (`file` type exists; no storage) | Required for later scope acceptance |
| More question types (matching, short answer, essay) with manual grading; answer review for students after release | Required for later scope acceptance |
| Gradebook extensions: weighting and categories, CSV export, institutional final-grade rules, late penalties, resubmission, group submissions | Required for later scope acceptance |
| Certificates; AI question generation | Required for later scope acceptance (named in task briefs as deferred) |
| Real AI tutor provider (§5) | Required for later scope acceptance (decision) |
| Admin reports and audit-log viewer | Optional future enhancement |
| Plagiarism detection (for example Turnitin) and AI-assisted grading | Optional future enhancement (needs a policy decision) |
| Semantic search, tutor conversation history | Optional future enhancement |

---

## 7. Decisions needed from Claudio

| Area | Decision or approval needed |
|---|---|
| GCP project & environment | Project and organization ownership, environments (dev / staging / prod), region and data residency, who operates and monitors them. |
| Hosting & database | Approve Cloud Run + load balancer + Cloud SQL (or an alternative). High availability, minimum instances, RPO/RTO and uptime targets. CI platform (Cloud Build or GitHub Actions). |
| Budget | Budget ceiling, billing alerts and quotas. No pricing is assumed in this report. |
| Real AI provider | Whether to adopt one, which vendor, data-processing terms, budget and quota caps, academic-integrity rules. Until approved, the tutor stays on the local mock. |
| Production security | Identity provider for SSO, pentest scope, WCAG level, data-retention periods, logging and privacy rules, incident response owner. |
| Next milestone | Proposed order: SSO and accounts → course administration → full ES/EN localization → CI/CD and GCP staging → then SCORM/LTI, file uploads or real AI, as Claudio prioritises. |

### Top risks

1. There is no institutional identity or user provisioning, so real users cannot be onboarded.
2. The interface is English-only apart from the tutor, while the target users are Spanish-speaking.
3. A course created as draft cannot be published later, and sections and visibility are fixed by the template.
4. There is no CI and the browser tests are not committed, so regressions depend on manual runs.
5. The login rate limiter does not hold across Cloud Run instances.
6. The tutor is a labelled mock; there is a risk of it being presented as real AI.
7. No production infrastructure, backups or monitoring exist yet.
