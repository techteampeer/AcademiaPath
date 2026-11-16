# Demo runbook — November 20, 2026 (stakeholder demonstration)

A short, practical sequence for presenting AcademiaPath to Claudio Obregón on the deployed demo environment. It covers
the core LMS and the features released in PR #46 (certificate signatories, professor e-mail composition, hybrid
teaching sessions). Every step was rehearsed automatically on synthetic data by `e2e/stakeholder-walkthrough.test.ts`
(see "Rehearsal" at the end). For local setup and the full role-by-role script, see `docs/demo-walkthrough.md`.

**No passwords are in this document.** The five demo accounts (`admin@`, `instructor@`, `reviewer@`, `ta@`,
`student@academiapath.example`) sign in with the credentials Sagar Patel holds; never paste them into slides, chat or
screen-shared notes.

## Before the demo (Sagar, 30 minutes)

1. Check that the latest `Deploy to Cloud Run (demo)` run is green and sign in once with each role you will show.
2. Use one browser profile per role (or private windows) so you can switch roles without signing out.
3. Choose the course for each part: **Project Management Fundamentals** (`PMF-2026-2-A`) for certificates, **ITIL 4
   Foundation** (`ITIL4-F-2026-2-A`) for the tutor and the study brief.
4. Have a real external meeting link ready (`https://…` from Zoom, Meet or Teams) for the hybrid session.
5. Remember that some actions create **permanent records** in the demo database: an issued certificate can be revoked
   but never deleted, and a published calendar event can be cancelled but not deleted. Do them once, on purpose.

## The sequence (about 35 minutes)

### 1. Administrator dashboard (admin, 2 min)
Sign in as the administrator → **Admin overview**. Point out the institutional overview, communications and the
administration menu.

### 2. Academic hierarchy (admin, 3 min)
**Academic structure** (academic years and terms) → **Programs & subjects** (programs, subjects and their codes) →
**Courses & enrollments** (each course offering belongs to a program and a term) → **Users** (accounts, roles,
activation state). Mention that course offerings are created from course templates in **Course setup**.

### 3. Course creation and content review (instructor → design team, 6 min)
- Instructor: open a course → **Add content** in a section → write a short lesson → **Save draft**.
- **Check content quality** on the course page: blocking issues and warnings, each with a fix.
- Open the lesson → **Submit for review**.
- Design team (reviewer): open the lesson → the activity's quality check runs on arrival → **Approve**. Show
  **Return with comments** on a second lesson: the comment is required and is shown to the author.
- Students only ever see approved content; returned or draft lessons stay invisible to them.

### 4. Hybrid sessions (instructor, 4 min)
Course → **Calendar** → **New event** → tick **This event is a teaching session**: session number, delivery mode
(**Live online**, **Asynchronous**, **Presentation**), the external classroom link, and the units covered. Show the
**Teaching sessions** plan: units and sessions are independent (one unit across several sessions, final presentations
without units). Asynchronous sessions can link a course activity instead of a live link.

### 5. Professor e-mail composition (instructor, 3 min)
Course page → **Compose email to students**: recipient count, the list of active students, subject and message →
**Open email application**. Students are in **BCC**, the instructor in **To**, nobody in CC. For large classes the page
offers **Copy BCC addresses**. **Do not press send** in the mail application: demo addresses are synthetic.

### 6. Student learning journey (student, 5 min)
Sign in as the student → **My courses** → a course: approved lessons, the **Calendar** with session badges and
**Enter virtual class** (opens the external link in a new tab), **Mark complete** on a lesson, and the progress card on
the course page.

### 7. Guided tutor (student, 3 min)
ITIL 4 Foundation → open **Guiding principles in practice** → **Ask the guided tutor about this lesson** → **Explain this
lesson**, then **Practice question** and answer it. Every answer quotes the approved course material and links to it.

### 8. Document study briefs (student, 3 min)
ITIL 4 Foundation → **Service value chain overview** (PDF) → **Create study brief** → key concepts and review
questions, each quoted from the document → follow a **page** link back to that place in the document.

### 9. Grades and progress (student, then instructor, 3 min)
Student: course → **My grades** (released grades only; the 0–20 scale and percentages). Instructor: **Gradebook** and
**Student progress** for the whole class.

### 10. Certificates with signatories (instructor → public, 4 min)
Project Management Fundamentals → **Certificates**:
- In the policy, keep **Require a final, released course grade**, untick **Require completing every learning
  activity**, and add one to three signatories under **Signatories (optional)** (full name and official title). **Save policy**. (With this rule
  the demo student is already eligible in this course; with a completion rule nobody in the seed is.)
- **Issue certificate** for the demo student → **Details** → **Download PDF**: the signature lines show each name
  and title.
- Open the **Verification page** in a private window (no sign-in): status, details and the signatories.
- Change a signatory in the policy and reload the verification page: the issued certificate keeps the signatories
  it was issued with.

## Say this clearly (honest limitations)

- **The guided tutor is deterministic, not generative AI.** It is rule-based and quotes approved course material;
  the interface says "rule-based, no generative AI". A real AI tutor is a later phase.
- **Study briefs are extractive.** They select and quote sentences from the document ("not written by AI").
- **Professor e-mail opens the user's own mail application.** AcademiaPath does not send, queue, deliver or track
  e-mail, and never claims it did.
- **Virtual classrooms are external HTTPS links** (Zoom, Meet, Teams…). AcademiaPath does not host video.
- **Certificate signatures are printed signer details** (name, title and a signature line), not handwritten,
  electronic or cryptographic signatures. Authenticity comes from the public verification page.

## If something goes wrong

- A page shows an error: reload once; if it persists, switch to the next section and note the time for Sagar.
- Sign-in fails for a role: use the administrator to show the same page (administrators can open any course), or skip.
- Do not change data with a cloud console, a database tool or a script during the demo.

## Rehearsal (automated)

`e2e/stakeholder-walkthrough.test.ts` runs this journey end to end on a disposable database with the synthetic demo seed:

```bash
E2E_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres bash e2e/run.sh test e2e/stakeholder-walkthrough.test.ts
```

It also runs with the full browser suite (`pnpm test:e2e`) and in the pull-request **Quality gates**. It proves the
flows on synthetic data; it is not a check of the deployed environment and does not replace manual QA
(`docs/release-quality-gates.md`).
