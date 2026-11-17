# Manual QA retest instructions (AP-QA-02)

Corrections for Havisha and Atharva after the AP-QA-01 triage. Results go in the team's QA spreadsheet, recorded by the
person who ran the check. This document does not change the spreadsheet.

**Ground rules**
- Use only the synthetic demo accounts (`*@academiapath.example`) and your own access to them. Never write a password
  in the sheet, a screenshot or a message.
- Run every check in English and in Spanish (EN/ES switch in the header).
- Administrator steps (course publication, the administrator catalogs) only with Sagar's explicit authorization.
- Record what you observed. When something looks wrong, note the account, course code, page, the exact message and the
  item's status badge.

**When to retest**
- TC-14, TC-20 and TC-24 were fixed in AP-QA-02. Retest them after AP-QA-02 is merged and deployed.
- TC-05, TC-12, TC-18, TC-19, TC-22 and TC-25 need no application change. Retest them now with the corrected steps.

## Fixed in AP-QA-02

### TC-24 — keyboard-only quiz (Havisha, `student@`)
1. Open ITIL 4 Foundation → the quiz. Using only the keyboard, press **Tab** until **Start quiz** has focus, then **Enter**.
   Expected: the page shows "Attempt 1 of N" and focus is on that heading.
2. **Tab** into the first question. **Space** selects an option; **↑/↓** move between the options of the same question
   (Tab moves to the next question, not to the next option — this is the standard browser behaviour). Checkboxes: Tab
   to each, Space to tick. **Shift+Tab** goes back.
3. Tab to **Submit attempt**, press **Enter**. Expected: a confirmation appears and focus is on **Confirm submission**.
4. Press **Tab**, then **Enter** on **Keep working**. Expected: focus returns to **Submit attempt**.
5. **Enter** (Submit) and **Enter** (Confirm submission). Expected: "Your attempt was recorded", with focus on it.
   Throughout, the focused control has a visible outline.

### TC-20 — quiz submission messages (Atharva, `instructor@`; approval by Havisha, `reviewer@`)
1. As `instructor@`, in a published course, **Add content** → type **Quiz** → **Save draft**, open it.
2. **Submit for review**. Expected: "Add at least one question before submitting the quiz for review."
3. Add a question with one correct option (**Add question**). Expected: "Question added." and the previous refusal is
   gone.
4. **Submit for review**. Expected: "Submitted for review."
5. As `reviewer@` (a different Design Team account), open it from the dashboard's **Awaiting review** → **Approve**.
6. As `student@`, open the quiz. Expected: **Start quiz** is available.

### TC-14 — clearing catalog filters
- **My courses** (Havisha as `student@`; Atharva as `ta@`, who also has a student course): type a search, then
  choose a **Role**. Expected: **Clear filters** appears; it empties the search and the role, shows every course again
  ("Showing N of N") and puts the cursor back in the search field. With no filter active, the button is not shown.
- **Administrator courses and users** (only with authorization, `admin@`): the same **Clear filters** action resets the
  search and every filter (term, program, status; or status and activation).

## No application change needed: corrected expectations

### TC-18 — content approval (Havisha, `reviewer@`)
- The review controls appear only on content that has been **submitted for review**. A draft shows Edit and Submit for
  review instead.
- The actions are **Approve** and **Return with comments**. There is no "Reject": returning (with a required comment)
  sends the item back to its author. Nothing needs to be configured; who may review is set per course by the
  administrator (the Design Team role).
- Nobody can approve their own submission: if `reviewer@` submitted an item, **Approve** is disabled with an
  explanation and another Design Team member must approve it.

**Steps:** `instructor@` submits a lesson → `reviewer@` opens it from **Awaiting review** → Return with comments
(try an empty comment: it is refused) → `instructor@` sees the comment, edits and resubmits → `reviewer@` approves →
`student@` sees the lesson.

### TC-19 — course publication (Atharva, `instructor@`)
- Publishing a course, creating sections and showing or hiding sections are administrator actions.
- For instructors and the Design Team, "publishing" content means Design Team approval of each item. There is no
  "Publish all" action.
- Test student visibility in a **published** course such as `ITIL4-F-2026-2-A`. The demo group `ITIL4-F-2026-2-B` is a
  draft course: its content stays invisible to students until an administrator publishes it.

### TC-25 — assessment details (Havisha, `student@`)
There is no page called "Assessment Overview". The same information is shown here:
- **Assignment page:** instructions, Due date, rubric criteria and points, Your submission, Your progress.
- **Quiz page:** Quiz details (questions, attempts allowed, time limit) and Your attempts.
- **My grades** (course page → My grades): every quiz and assignment with its status.
- **Dashboard → Upcoming** and the **Calendar**: deadlines.

### TC-22 — guided tutor and quizzes (Havisha, `student@`)
The tutor is an open-book study aid. It quotes the course's approved, visible lessons and documents. If a quiz question
is written from a lesson's text, asking the tutor that question shows the lesson passage that contains the answer — the
same passage the student can read in the lesson itself. This is expected.

Record a defect only if the tutor shows any of these:
- a quiz's questions or answer options as such, or which option is marked correct in a quiz;
- text from a draft, submitted, returned or hidden item;
- content from a course you are not enrolled in.

(Automated tests now check all of these on every pull request.)

### TC-05 and TC-12 — language
- Interface text (menus, buttons, labels, status badges, dates, messages and errors) follows the EN/ES switch.
- Course content written by instructors stays in the language it was written in and is never translated. In the demo:
  in English, the ITIL course's announcements, forum topics and calendar events are in Spanish, and the IAI course is in
  Spanish; in Spanish, the ITIL and PMF lesson titles, descriptions and documents are in English.
- Record each mismatch as **interface** (a defect), **authored content** or **demo data** (not defects).
- Known interface issue, reported separately: the options of **true/false** quiz questions read "True" / "False" in
  the Spanish interface.
