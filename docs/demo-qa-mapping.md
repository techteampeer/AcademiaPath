# Demo workflows for manual QA (AP-016)

This maps the demo walkthrough (`docs/demo-walkthrough.md`) to manual checks for the frontend contributors. It is a
planning aid. **No manual test in this list has been run or passed.** Results belong in the team's manual QA spreadsheet,
recorded by the person who ran the check.

- **The spreadsheet was not reviewed.** The Google Drive connector available while preparing AP-016 lacked the needed permission, so its column structure could not be checked and it was not modified. Map the fields below (ID, workflow, preconditions, steps, expected result) to the spreadsheet's existing columns when copying cases.
- **Setup.** Follow "Set up" in `docs/demo-walkthrough.md` on a fresh local database (`pnpm db:migrate`, `pnpm db:seed:demo`, `pnpm dev`). Use only the synthetic accounts. Every account's password is the tester's own local `DEV_SEED_PASSWORD`.
- **Language.** On `main` the EN/ES switch covers the sign-in page, navigation, dashboards, administration pages (except Course setup), My courses and the course overview. Lessons, quizzes, assignments, grades and documents are English-only until the AP-015 bilingual frontend is merged. Run the full EN/ES checks after that merge.

## Havisha: shared UI components (`apps/web/src/components/ui/`)

| ID | Walkthrough step | Workflow | Steps | Expected result |
| --- | --- | --- | --- | --- |
| DEMO-UI-01 | 1 | Sign-in form | Submit an empty form, then an invalid email, then a wrong password, then `admin@` with the correct password. | Field errors are announced next to their fields. The wrong password shows a generic "Invalid email or password". A valid sign-in opens the dashboard. |
| DEMO-UI-02 | 2–3 | Admin tables | Open Academic structure, Programs & subjects and Courses & enrollments at desktop width and at 390 px. | Tables scroll inside their container, with no page-level horizontal scroll. Headers stay readable. |
| DEMO-UI-03 | 4, 15 | Review decision controls | As `reviewer@`, open a submitted lesson. Choose **Return** with an empty comment, then **Approve**. | Return requires a comment and shows an inline error. Buttons are disabled while the request is pending. A success message appears, and the status badge changes to Approved. |
| DEMO-UI-04 | 5, 7 | Status badges and counts | Compare the Draft / Awaiting review / Approved / Returned badges and the Needs grading / Graded, not released counts on the dashboards. | Badges use consistent colours and text, not colour alone. Counts match the seeded data (see the walkthrough tables). |
| DEMO-UI-05 | 10 | Form buttons and pending states | Submit an assignment and a quiz attempt. | The button shows a pending label and cannot be submitted twice. The confirmation is visible and announced. |
| DEMO-UI-06 | 13–14 | Mock AI labels | Open the tutor and a document summary. | "Mock AI — local demonstration" and "Mock AI summary — local demonstration" are visible near the generated text. |
| DEMO-UI-07 | All | Keyboard and focus | Complete steps 8–10 using the keyboard only. | Every control is reachable, with a visible focus ring and a logical order. Dialogs and menus can be closed with Esc where applicable. |
| DEMO-UI-08 | All | Empty and error states | As `student@`, open a course page with no grades released (Introduction to AI → My grades). Stop the API and reload a page. | A clear empty state is shown. The error message is understandable, with no stack trace and no blank page. |

## Atharva: course and student UI (`apps/web/src/components/courses/`, `apps/web/src/components/students/`, `apps/web/src/mocks/`)

| ID | Walkthrough step | Workflow | Steps | Expected result |
| --- | --- | --- | --- | --- |
| DEMO-CS-01 | 8 | Student course list | Sign in as `student@` and open My courses. | Exactly three courses are listed: ITIL 4 Foundation, Project Management Fundamentals and Introduction to Artificial Intelligence. The draft evening group is absent. |
| DEMO-CS-02 | 8 | Course roles per course | Sign in as `ta@` and open the dashboard. | ITIL and Project Management appear under Read & grade. Introduction to AI appears as a student course with no gradebook link. |
| DEMO-CS-03 | 8–9 | Student course content | As `student@`, open each course. | Three sections each. No "Instructor notes" / "Notas docentes" section, and no drafts, submitted or returned lessons ("Change enablement", "Earned value basics", "Redes neuronales…" are absent). |
| DEMO-CS-04 | 9 | Lesson reading | Open "The four dimensions of service management". | The full approved text renders with readable headings, and the page works at 390 px. |
| DEMO-CS-05 | 10 | Quiz taking | Start the ITIL quiz, answer all three question types and submit. | Single choice uses radios, multiple choice uses checkboxes, true/false shows two options. After submission, no correct answers are shown until grades are released. |
| DEMO-CS-06 | 10 | Assignment submission | Submit the ITIL assignment. | The due date and rubric criteria are visible. The submission is shown as submitted, and the grade as not yet released. |
| DEMO-CS-07 | 12 | Student grades | Open My grades in all three courses. | Project Management shows 15 and 18 out of 20. ITIL shows the grades only after step 11. Introduction to AI shows nothing released. |
| DEMO-CS-08 | 7, 11 | Staff gradebook | As `ta@` in ITIL, open the gradebook. | Students and statuses match the seeded data. Grading learner.b's essay changes the status from Needs grading to Graded, not released. |
| DEMO-CS-09 | 16 | Approved document for students | After step 15, open the uploaded document as `student@`. | The approved summary and Download original are available. Unapproved revisions are not shown. |
| DEMO-CS-10 | — | Test data (`apps/web/src/mocks/`) | Check that any mock data used in previews stays synthetic. | Only `academiapath.example` accounts and "Demo" names. No real people or institutions. |

## Covered by automated checks (not manual QA)

`apps/api/test/demo/seed-demo.test.ts` runs against a temporary local PostgreSQL database. It checks:
- the course and enrollment matrix
- repeatable seeding with no duplicates
- published-only course lists and hidden drafts, sections and unapproved items
- private answer keys and server-side quiz scores
- grades hidden until release
- tutor citations from approved lessons only
- document summaries quoting extracted text
- course-specific permissions
- synthetic-only accounts and audit records

These automated results do not replace the manual cases above, which check what people see and use in the browser.
