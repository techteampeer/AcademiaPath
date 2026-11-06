# AcademiaPath demo walkthrough (local, synthetic data)

This walkthrough presents the LMS end to end on a developer machine: three published courses in term 2026-2, the five
roles, review and approval, quizzes and assignments with server-side grading and release, the course tutor and course
documents.

- **Everything is synthetic.** Accounts use the reserved `academiapath.example` domain and the names "Demo …". All
  course material, documents, answers and grades were written for this demo. There are no real student or institutional
  records.
- **AI features are mocks.** The tutor and the document summaries are deterministic local programs. No AI model or
  external service is called. The UI labels them **"Mock AI — local demonstration"** and
  **"Mock AI summary — local demonstration"**.
- **Local only.** Nothing is deployed. The seed refuses to run when `NODE_ENV=production` or when `DATABASE_URL` points at
  a non-local host.

## 1. Set up

Prerequisites: Node.js 22.19+, pnpm 10 and a local PostgreSQL 16 server.

```bash
pnpm install
createdb academiapath_demo
```

In your own uncommitted root `.env` (start from `.env.example`), set:

```bash
DATABASE_URL=postgresql://localhost:5432/academiapath_demo
DEV_SEED_PASSWORD=<choose a local password of at least 12 characters>
```

Then:

```bash
pnpm db:migrate
pnpm db:seed:demo
pnpm dev
```

Open http://localhost:3000/login.

`pnpm db:seed:demo` does four things:
- creates or updates the synthetic accounts, using the same process as `pnpm db:seed:dev`
- drives the real API in-process as those signed-in users to build the dataset
- prints the course IDs and how many records it created or found
- writes two files for the live upload step to `~/.academiapath/demo-files` (override with `DEMO_FILES_DIR`, which must be outside the repository)

Uploaded documents are stored in `DOCUMENT_STORAGE_DIR` (default `~/.academiapath/documents`). Use the same value for `pnpm db:seed:demo` and `pnpm dev`.

**Re-running.** The seed is idempotent. A second run finds every program, term, subject, course, enrollment, activity, attempt, submission, grade and release, and creates nothing. It never deletes data and never reverts a decision made in the UI. For example, content you approved or returned during a rehearsal stays that way.

**Restoring the starting state.** Use a separate database: drop and recreate `academiapath_demo`, then run `pnpm db:migrate` and `pnpm db:seed:demo` again. Never point the seed at a shared or institutional database.

## 2. Accounts

Every account signs in with the `DEV_SEED_PASSWORD` you set in your local `.env`. No password is stored in the repository. Running the seed again with a new value changes the password of these synthetic accounts only.

| Account | System role | ITIL 4 Foundation | Project Management Fundamentals | Introduction to AI | ITIL evening group (draft) |
| --- | --- | --- | --- | --- | --- |
| `admin@academiapath.example` | Administrator | – | – | – | – |
| `reviewer@academiapath.example` | User | Design team | Design team | Design team | Design team |
| `instructor@academiapath.example` | User | Instructor | Instructor | Instructor | Instructor |
| `ta@academiapath.example` | User | Non-editing instructor | Non-editing instructor | **Student** | – |
| `student@academiapath.example` | User | Student | Student | Student | Student (not visible: draft) |
| `learner.a@academiapath.example` | User | Student | Student | – | – |
| `learner.b@academiapath.example` | User | Student | – | Student | – |

`ta@` shows course-specific roles: it grades in ITIL and Project Management but is a student in Introduction to AI.

## 3. What the seed creates

**Academic structure (year 2026).**
- Terms: `2026-1` (Semestre 2026-1) and `2026-2` (Semestre 2026-2).
- Reusable programs: `GTI` IT Service and Project Management, and `CDIA` Data Science and Artificial Intelligence.
- Subjects (course templates) and their 2026-2 offerings:

| Offering | Subject | Program | Status | Language |
| --- | --- | --- | --- | --- |
| `ITIL4-F-2026-2-A` ITIL 4 Foundation | `ITIL4-F` | GTI | Published | English |
| `PMF-2026-2-A` Project Management Fundamentals | `PMF` | GTI | Published | English |
| `IAI-2026-2-A` Introduction to Artificial Intelligence | `IAI` | CDIA | Published | Spanish |
| `ITIL4-F-2026-2-B` ITIL 4 Foundation (evening group, not yet published) | `ITIL4-F` | GTI | Draft | – |

Each published course has:
- three visible sections plus one hidden section of instructor notes
- approved text lessons and a safe external reference link (Wikipedia)
- a quiz mixing single-choice, multiple-choice and true/false questions
- an assignment with a rubric and a due date (4 Dec 2026, 23:59 Lima time)
- one uploaded synthetic document (PDF or Word) with an approved extractive mock summary

Content in review states, used to demonstrate review permissions:

| Course | Item | State |
| --- | --- | --- |
| ITIL 4 Foundation | Lesson "Change enablement" | Submitted, awaiting the design team |
| ITIL 4 Foundation | "Facilitator notes for module 2" (hidden section) | Draft |
| Project Management Fundamentals | Lesson "Earned value basics" | Returned with a reviewer comment |
| Introduction to AI | Lesson "Redes neuronales: intuición básica" | Submitted, awaiting the design team |

Student work, graded on the server:

| Course | Student | Quiz | Assignment | Released to the student? |
| --- | --- | --- | --- | --- |
| ITIL 4 Foundation | learner.a | 4/4 | 8/10 | Yes (20 and 16 out of 20) |
| ITIL 4 Foundation | learner.b | 1/4 | Submitted, needs grading | No |
| ITIL 4 Foundation | student | – | – | Left for the live demo |
| Project Management | student | 3/4 | 9/10 | Yes (15 and 18 out of 20) |
| Project Management | learner.a | – | 7/10 | No (graded after the release) |
| Introduction to AI | learner.b | 4/4 | 9/10 | Yes |
| Introduction to AI | student | 2/4 | – | No |
| Introduction to AI | ta (as a student) | 1/4 | – | No |

## 4. Demo script

Course paths below are relative to http://localhost:3000. The seed prints each course's ID, and the **My courses** and **Dashboard** pages link to every course.

### Administrator
**1. Sign in as the administrator.** Sign in as `admin@academiapath.example`. You land on **Admin overview** (`/admin`), and the sidebar shows **Administration**.

**2. Open the academic hierarchy.** Go to **Administration → Academic structure** (`/admin/academics`). In **Hierarchy**, keep academic year 2026 and select term 2026-2. The term shows its 4 offerings and both programs (GTI with 3 offerings, CDIA with 1). Select a program to see its subjects and offerings.

**3. Review programs, terms and offerings.**
- **Programs & subjects** (`/admin/programs`) lists GTI and CDIA with their subjects.
- **Courses & enrollments** (`/admin/courses`) lists the four 2026-2 offerings, including the draft evening group, and their enrollments.
- **Course setup** (`/admin/setup`) creates terms, programs, subjects and offerings through the same API.

### Design team
**4. Review submitted material.** Sign in as `reviewer@academiapath.example`.
- The **Dashboard → Content review** panel counts items awaiting review in ITIL 4 Foundation and Introduction to AI.
- Open ITIL 4 Foundation. Its review queue lists **Change enablement**. Open it and, under **Review decision**, choose **Approve**. **Return with comments** requires a comment.
- In Project Management, the instructor sees the returned lesson "Earned value basics" with the reviewer's comment ("Returned for changes: …").
- Instructors cannot approve: the API refuses with 403.

### Instructor
**5. Teaching dashboard.** Sign in as `instructor@academiapath.example`. **Dashboard → Teaching** lists the courses taught, including the draft evening group, with grading counts.

**6. Quiz and assignment workflows.** Open ITIL 4 Foundation → Module 3.
- **Module check: ITIL 4 foundations** shows the questions and answer key (staff only) and the results computed by the server (learner.a 4/4, learner.b 1/4).
- **Mapping a service to the value chain** shows the rubric, the due date and the submissions (learner.b needs grading).

### Non-editing instructor
**7. Grade without editing content.** Sign in as `ta@academiapath.example`.
- **Dashboard → Read & grade** lists ITIL 4 Foundation and Project Management.
- In ITIL 4 Foundation, open the assignment, grade learner.b's submission against the rubric and choose **Save grade**.
- There is no **Add content** or edit control, and the API refuses content changes from this role.
- Open Introduction to AI: here `ta@` is a student, so there is no gradebook and only approved content is shown.

### Student
**8. Enrolled courses.** Sign in as `student@academiapath.example`. **My courses** shows ITIL 4 Foundation, Project Management Fundamentals and Introduction to Artificial Intelligence. The draft evening group, hidden sections, drafts, submitted and returned items are not shown.

**9. Read an approved lesson.** In ITIL 4 Foundation, open Module 2 → **The four dimensions of service management**.

**10. Complete the quiz and the assignment.**
- In Module 3, open the quiz and choose **Start quiz**. Answer, then choose **Submit attempt** → **Confirm submission**. The browser never receives the answer key; the API scores the attempt.
- Open **Mapping a service to the value chain**, write a short answer and choose **Submit assignment** → **Confirm submission**.

### Instructor
**11. Release grades.** Sign in as `instructor@` (or `ta@`). In ITIL 4 Foundation:
- Grade the student's assignment.
- Choose **Release assignment grades**. Then release the quiz with **Release quiz grades** on the quiz page, or **Release** in its **Gradebook** column.

Release publishes the current grades of every graded student for that activity. Students see only what has been released.

### Student
**12. See released grades.** As `student@`, open ITIL 4 Foundation → **My grades**. The released quiz and assignment appear on the 0–20 scale with feedback. Project Management Fundamentals already shows released grades (15 and 18). Introduction to AI shows the quiz as not yet released.

**13. Use the mock tutor.** Open ITIL 4 Foundation → **Tutor** (labelled "Mock AI — local demonstration"). The response language follows the interface language and can be changed under **Response language**.
- Ask "What are the four dimensions of service management?". The answer cites approved lessons of this course only.
- Ask about "change enablement" before that lesson is approved: it is not cited.
- In Introduction to AI the tutor answers in Spanish from the Spanish lessons, for example "¿Qué es el aprendizaje supervisado?".

### Instructor
**14. Upload a document and refresh its mock summary.** As `instructor@`, open ITIL 4 Foundation → **Document library** → **Upload a document**.
- Choose a section, for example Module 3, and the file `~/.academiapath/demo-files/itil-continual-improvement.pdf`. For Project Management, use `pm-stakeholder-map.docx`.
- The API checks the file, extracts its text and creates a mock summary (labelled "Mock AI summary — local demonstration") that quotes the document with page references.
- **Refresh summary** creates a new summary revision.
- Choose **Submit for review**.

### Design team
**15. Approve the new content.** As `reviewer@`, open the uploaded document (or the "Change enablement" lesson, if not approved in step 4) and choose **Approve**.

### Student
**16. Open the approved document.** As `student@`, open the document in ITIL 4 Foundation. The approved summary and **Download original** are available. Unapproved revisions are never shown to students.

## 5. Notes and limitations

- **Bilingual UI.** The header's EN/ES switch translates the whole interface (AP-015). Course material stays in the language it was written in: English (ITIL, Project Management) and Spanish (Introduction to AI).
- **Course lifecycle (optional extra step).** As `admin@`, **Courses & enrollments → Manage** on a course shows its status, sections and roster. Unpublishing ITIL 4 Foundation hides it from students at once without deleting anything; publishing it again restores the same view. Do this only on a rehearsal database.
- **No malware scanning.** No malware scanner is connected, so uploads are recorded as `not_scanned`. Only use the synthetic demo files.
- **Mock AI only.** Mock summaries and tutor answers quote approved course text. They are not AI-generated and must be presented as mock functionality.
- **Wall-clock dates.** Due dates and quiz time limits use real time. The assignment due date (4 Dec 2026, 23:59 Lima time) keeps submissions open for the November demo.
