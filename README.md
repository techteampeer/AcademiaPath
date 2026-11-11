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

Program-scoped academic management: in **Academic structure → program → Program managers** an administrator can grant a user management of that program's subjects (API `/programs/{programId}/managers`). The user then gets an **Academic management** workspace (`/academic`) where they create and version the subjects of their programs only, through the normal course-template endpoints, and see each subject's version history. Authorization uses the program stored on the subject, is checked inside the writing transaction (a revocation or deactivation applies to the next request, and a write in progress finishes first), and is audited. Grants never make anyone an administrator and give no access to courses, enrollments, grades, submissions, quiz answers, terms or user management; course design-team roles do not imply them.

Course lifecycle: administrators manage each offering under **Courses & enrollments → Manage** (`/admin/courses/{id}`; API `GET /courses/{id}/lifecycle`, `PUT /courses/{id}`, `POST /courses/{id}/publish|unpublish`, section and enrollment endpoints in the contract). They edit details (the code only while the course is a draft), publish and unpublish through explicit transitions, add, rename, show or hide and reorder sections, and deactivate, reactivate or (when it has no history) remove enrollments. Every change names the course `version` it is based on or is serialized per course, so concurrent edits are refused rather than lost. Publishing never reveals unapproved content, hidden sections or unreleased grades; unpublishing and deactivation never delete content, attempts, submissions, grades or audit records; offering changes never modify the subject template.

Learning progress: students see server-calculated progress on their dashboard and course pages (API `GET /me/progress`, `GET /courses/{id}/progress`, `GET /courses/{id}/sections/{sectionId}/progress`). Lessons, links and documents are completed by marking them (`PUT`/`DELETE /courses/{id}/activities/{activityId}/completion`); quizzes complete when an attempt is submitted (passing is not required) and assignments when they are submitted, so that completion cannot be set by hand. Only approved, visible activities in visible sections count; percentages round down and courses without such activities show no percentage. Progress never includes scores or grades. Instructors, non-editing instructors and administrators read a per-student overview (`/courses/{id}/progress`); the design team does not. Administrators can make a section require other sections (**Courses & enrollments → Manage → Section prerequisites**); the API then refuses that section's lessons, documents, quizzes and assignments to students with `403 SECTION_LOCKED` until the required sections are complete, and the tutor does not use them. Cycles are refused.

Assessment controls: quiz settings add a passing score, correctness feedback after release, and a question pool size (questions drawn at random per attempt; all questions must then be worth the same points), alongside the existing attempt limit, time limit and shuffling. All of these are reviewed with the quiz, and earlier quizzes keep their behaviour. The server chooses each attempt's questions and their order, stores them with the attempt, and refuses any change, so refreshes and browser clocks cannot alter an attempt. Deadlines use the API server clock: answers are accepted up to and including the deadline instant and never after it (there is no grace period). An expired attempt is finalized with the answers saved in time as soon as any attempt, result, grade or progress view is requested; there is no background job, and finalization happens once even under concurrent requests. Students see whether they passed, and (when enabled) which of their answers were correct, only after their grade is released; answer keys are never shown to students. Editors can reuse questions by importing the approved questions of another quiz in the same course; the copies are reviewed again. Released quiz results are judged by the passing score saved with the released attempt, so later changes to the quiz never alter them.

Advanced gradebook: instructors (and administrators) can group quizzes and assignments into weighted grade categories (for example Quizzes 40 %, Assignments 60 %). A draft never affects grades; a published policy must total exactly 100 %, and each activity belongs to at most one category. Without a published policy the course grade is the original unweighted sum of points. With one, each category's percentage is its graded points over its graded maxima and the course percentage is the weighted average over the categories that have graded work; work not submitted or not graded is never counted as zero (an earned 0 is). Course grades are labelled *final* only when every counted activity has a released, current grade, and *provisional* otherwise. The gradebook shows pending and unreleased work, a per-student drilldown, controlled individual or bulk release (instructors only; each item names the revision that was reviewed, so later changes are never released by accident) and a CSV export with formula-safe text. Students see only released grades and a course grade calculated from them. Non-editing instructors have read-only access, and program-management grants give no gradebook access.

Course roles: editing course content and assessing student work are separate permissions. Instructors author content, grade, release grades, set the grading and certificate policies, and issue or revoke certificates. Non-editing instructors never change content, policies or what students see: they grade submissions against the rubric (scores and feedback stay hidden until an instructor releases them) and read the gradebook, progress and certificates. The design team authors and reviews content only. Administrators read everything and can configure policies and issue or revoke certificates, but never take, grade or release work.

Course completion certificates: a course issues certificates only under an enabled certificate policy (**Course → Certificates**), which requires course completion (every progress-tracked activity complete), a final released course grade, or both, plus an optional minimum grade compared exactly against that final grade; the course must be published and the enrollment active. The server evaluates eligibility from progress and released grades, and re-evaluates it when an instructor or administrator issues a certificate; there is at most one valid certificate per student and course. Each certificate keeps a snapshot of the student's name, course, period, issuer and policy, is never deleted, and can only be revoked with a reason. Students see their status and download PDFs (generated locally, without e-mail addresses or grades) from **My certificates**; anyone can check a certificate at `/verify/{token}`, which shows only whether it is valid or revoked and the details printed on it.

Announcements and academic calendar: instructors and administrators write plain-text course announcements (never rendered as HTML), save them as drafts, publish them now or schedule a future publication, pin and archive them (announcements are never deleted); administrators publish institution-wide announcements. Students see institution-wide announcements and those of courses with an active enrollment, pinned first and then newest, mark them read (the unread count is calculated on the server) and lose access when the enrollment ends. Drafts and scheduled announcements stay invisible until the server clock reaches the publication time; there is no background scheduler. Calendar events belong to one course or the institution, are stored as UTC instants with an explicit IANA time zone (all-day events keep their dates), can be hidden, published, cancelled or (if never published) deleted, and every change is audited. The institution's default time zone is `America/Lima` (`INSTITUTION_TIME_ZONE`); timed input must carry an explicit offset and the server's local zone is never used. Assignment due dates appear in the calendar only from approved assignments. Non-editing instructors read announcements and events; program and design-team grants give no publishing rights. No e-mail or push notifications are sent.

Messaging and notifications: every conversation belongs to one published course. A direct conversation joins a student and the course's instructor or non-editing instructor; the course conversation is shared by the course's current students and teaching staff. Access is derived from current active enrollments on every request, so a revoked enrollment, a deactivated account or an unpublished course ends it at once. Administrators and the design team never read private conversations. Administrators can only lock or unlock course conversations, which instructors also moderate (hide a message, lock). Messages are plain text (up to 4000 characters), ordered by a server sequence, never deleted, never logged, rate-limited per person (`MESSAGE_RATE_LIMIT_MAX` per `MESSAGE_RATE_LIMIT_WINDOW_MINUTES`) and safe to retry: a client message id prevents duplicates. In-app notifications (no e-mail, SMS or push) are recorded in the same transaction as their event: a direct or course message, a published announcement (shown from its publication time and withdrawn if archived), a released grade (never its value) and an issued certificate. There is one notification per recipient and event, and a repeat refreshes it instead of duplicating it. Notifications are shown only while the recipient can still access the course. Updates are near-real-time by authenticated polling, which pauses in hidden tabs and stops when the page closes. There is no WebSocket or message broker, so delivery takes a few seconds and is not instant.

Learning resources: course editors (instructors, the design team, administrators) add links as a **website**, **video** or **interactive** resource. Every kind is only a link that opens on its own site in a new tab; nothing is embedded, hosted, fetched or executed. New and edited links must use `https://` on a domain name without credentials. On the course page, editors group lessons, links and documents into resource folders within a section, reorder folders and content, move content between folders, and show or hide it (API `…/resource-folders`, `…/activities/order`, `…/activities/{activityId}/organization`). Resources are ordinary content activities: they go through the same review, visibility, prerequisite and progress rules, and each counts once in a student's progress. Students only see approved, visible resources, and only folders that contain them. Folders are deleted only when empty.

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
