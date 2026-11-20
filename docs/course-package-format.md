# Course package format, version 1 (AP-038A, AP-038B)

A course package is the portable copy of one course's reusable content. `GET /api/v1/courses/{id}/export` (AP-038A)
returns one JSON document, saved as `course-<code>.academiapath.json`; `POST /api/v1/course-imports/preview` and
`POST /api/v1/course-imports` (AP-038B) turn it into a new draft course (see "Import"). The authoritative schemas are
`CoursePackage`, `CourseImportPreview`, `CourseImportRequest` and `CourseImportResult` in
`packages/contract/openapi.yaml`.

## Who may export

The course's design team and instructors, and administrators (permission `content.export`). Non-editing instructors
and students get 403; anyone who cannot see the course gets 404. The package contains quiz answer keys and unapproved
drafts, so treat the file like the course itself: share it only with people who may author the course.

## Structure

```jsonc
{
  "format": "academiapath.course-package",   // always this value
  "formatVersion": 1,                          // see "Versioning"
  "exportedAt": "2026-11-16T10:00:00.000Z",
  "contentHash": "sha256:…",                   // same content → same hash
  "source": { "courseCode": "ITIL-A", "courseStatus": "published" },   // informational only
  "course": {
    "title": "…", "description": "…",
    "units": [{
      "key": "unit-1", "title": "…", "summary": null, "position": 0, "visible": true,
      "requiresUnitKeys": [],                  // prerequisites (other unit keys)
      "folders": [{ "key": "folder-1", "title": "Readings", "position": 0 }],
      "activities": [{
        "key": "activity-1", "type": "page", "position": 0, "visible": true,
        "folderKey": null,
        "reviewStatus": "approved",            // draft | submitted | approved | returned
        "working":  { "title": "…", "content": { "body": "…" } },   // the authors' current copy
        "approved": { "title": "…", "content": { "body": "…" } }    // what students see; null if never approved
      }]
    }]
  },
  "assets": [{ "key": "asset-1", "kind": "document", "fileName": "guide.pdf", "format": "pdf",
               "byteSize": 48211, "sha256": "…", "bundled": false }],
  "warnings": [{ "code": "ASSET_NOT_BUNDLED", "target": "assets", "detail": "…" }],
  "excludedData": ["people", "enrollments", "student_work", "grades", "…"],
  "counts": { "units": 3, "folders": 1, "activities": 7, "approvedActivities": 5, "questions": 3, "assets": 1 }
}
```

`content` by activity type:

| Type | Content |
| --- | --- |
| `page` | `{ body }` (plain text) |
| `link` | `{ url, description, kind }` (`website`, `video` or `interactive`) |
| `quiz` | settings (`instructions`, `attemptLimit`, `timeLimitMinutes`, `shuffleQuestions`, `shuffleOptions`, `passingScorePercent`, `showFeedback`, `questionsPerAttempt`) and `questions`: `{ key, type, prompt, points, options: [{ key, text }], correctOptionKeys }`. The working copy holds the question bank; the approved version holds the questions published at approval. |
| `assignment` | `{ instructions, dueAt, lateUntil, rubric: [{ key, title, description, maxPoints }] }` |
| `file` | `{ assetKey, fileName, format }`; `assetKey` points into `assets` (null when the reference is invalid) |
| `scorm`, `lti` | `null`: not portable yet (a warning says so) |

Units, folders and activities are listed in course order (unit position, then activity position). Positions are kept
as stored.

## What a package never contains

People and everything about them (accounts, enrollments, quiz attempts, assignment submissions, grades, completions,
messages, forum posts, groups), credentials and tokens, the audit log, review comments and reviewer identities,
database identifiers, the course's institutional placement (program, term, template, code reuse), calendar events and
teaching sessions (they are term-specific), certificates and the certificate policy (signatories are institution
staff), the grading policy, extracted document text and summaries (derived from the file), and file bytes. The
package lists these categories in `excludedData`.

## Identifiers and how the import remaps them

The package never uses database identifiers. Every reference is a **package-local key**, assigned in course order:

| Key | Scope | Refers to |
| --- | --- | --- |
| `unit-<n>` | package | a section; used by `requiresUnitKeys` |
| `folder-<n>` | package | a resource folder; used by `folderKey` |
| `activity-<n>` | package | an activity |
| `asset-<n>` | package | a document file; used by `assetKey` |
| `q<n>` | one question list | a quiz question |
| `o<n>`, `true`, `false` | one question | an option; used by `correctOptionKeys` |
| `c<n>` | one rubric | a rubric criterion |

The import (AP-038B) never uses a key as a database identifier. It creates every row with a new identifier, in order
(units, prerequisites, folders, activities, quiz questions), keeping a map from each key to its new row, and resolves
prerequisites and folders through that map. Quiz options get new identifiers and each answer key is rebuilt from the
options it names; rubric criteria get new identifiers.

## Import (AP-038B)

Administrators only (like creating a course); course authors, non-editing instructors and students are refused by the
API. Two steps, both stateless (nothing is stored between them):

1. **Preview** (`POST /course-imports/preview`, body: the package file). Writes nothing. Reports the format and
   version, whether the content hash matches, the source course, counts (units, folders, activities by type, quiz
   questions), every document reference with its availability, the activities that cannot be imported, the fields this
   version does not know (ignored), and every validation problem with its JSON path.
2. **Import** (`POST /course-imports`). Validates the package again, then, in **one transaction** (a failure leaves
   nothing behind), creates a **new** course in the chosen program and term with the given code. A code already used in
   that term is refused (`409 COURSE_CODE_TAKEN`): no course is ever overwritten, and a repeated or concurrent
   confirmation creates the course once.

What is created:

| From the package | In the new course |
| --- | --- |
| Course title (or the title given) and description | A course with status `draft` and no template |
| Units in order, with summary and visibility | Sections in the same order |
| Prerequisites | Section prerequisites between the new sections |
| Resource folders | Folders in the same units and order |
| Lessons, links, quizzes, assignments | Activities in the same order, visibility and folder, every one a **draft** (no approval, review state or publication travels) |
| Quiz settings and questions | The same settings and questions, new option ids, rebuilt answer keys |
| Assignment instructions and rubric | The same instructions and rubric; the due date chosen at import (`assignmentDueAt`) and no late window |

`versionPreference` chooses, for activities that have both, the approved version (default: what students of the source
course saw) or the authors' working copy; activities never approved always use their working copy.

Never created: people, enrollments, quiz attempts, submissions, grades, completions, messages, documents, calendar
events and teaching sessions, certificates and their policies, grading policies.

### Validation and compatibility rules

- `format` must be `academiapath.course-package` and `formatVersion` must be `1` (`IMPORT_VERSION_UNSUPPORTED`).
- `contentHash` must match the content. It is recomputed over the content rebuilt in the export's canonical form, so the
  order of keys in the file does not matter, but any change to the content does (`IMPORT_HASH_MISMATCH`). Fields
  outside the hashed content (`exportedAt`, `source`, `warnings`, `counts`, `excludedData`) are informational.
- Every value is checked with the authoring limits: text lengths, non-empty lessons, links only `https://` on a domain
  name without credentials (others are refused, including older `http://` links), quiz settings in range, each answer
  key naming options of its own question (one for single-choice and true/false, at least one for multiple-choice),
  rubric points from 1 to 100.
- Keys are unique, and every reference resolves inside the package: prerequisites to other units (no cycles), folders
  to folders of the activity's own unit (reading activities only), assets to listed assets.
- Limits: at most 20 MB per package, 200 units, 100 folders per unit, 1000 activities, 100 questions per quiz.
- Fields this version does not know are reported in the preview and ignored, never imported.
- Malformed JSON is refused with `400`; anything else with `422 IMPORT_PACKAGE_INVALID` naming the first problem (the
  preview lists them all).

### Documents and unsupported activities

Version 1 packages do not contain document files, so **document activities cannot be imported** and AcademiaPath never
creates a document activity without its file. The preview lists every document (`not_bundled`, or
`missing_at_source` when the file was already missing at export) and every activity that will not be created
(`DOCUMENT_NOT_BUNDLED`; `UNSUPPORTED_ACTIVITY_TYPE` for `scorm` and `lti`). An import with such activities is refused
(`IMPORT_ACKNOWLEDGEMENT_REQUIRED`) unless the administrator explicitly confirms a content-only import
(`acknowledgeSkipped: true`); the result lists exactly what was skipped. Moving document files is AP-040 work (see
below).

## File assets (limitation)

Version 1 describes each document (`fileName`, `format`, `byteSize`, `sha256`) but does not include its bytes
(`bundled: false`, warning `ASSET_NOT_BUNDLED`). Uploaded documents live in the institution's private storage (a Cloud
Storage bucket mounted by the API); moving them needs a ZIP package and an upload path on the target side, which is
AP-040 work. Until then a document activity is portable as a reference only: an importer must obtain the file
separately and can verify it with `sha256`. A file missing from storage is reported as `ASSET_MISSING`.

### Course archive (AP-038C1C engine, AP-038C1D API)

`apps/api/src/portability/course-archive.ts` assembles a ZIP holding the package and its document files.

**API:** `GET /api/v1/courses/{id}/export/archive` (contract `exportCourseArchive`).
- **Permission:** the same as the JSON export (`content.export`).
- **Response:** `application/zip`, attachment `course-<code>.academiapath.zip`, `no-store`, `nosniff`.
- **Errors:**

  | Situation | Response |
  | --- | --- |
  | Archive over 25 MB | 422 `COURSE_ARCHIVE_TOO_LARGE` |
  | A missing or changed document file | 500 `COURSE_ARCHIVE_DOCUMENT_MISSING` / `COURSE_ARCHIVE_DOCUMENT_CORRUPT` |
  | Unreadable storage | 503 `DOCUMENT_STORAGE_UNAVAILABLE` |
  | Two archives already being prepared on this API instance | 503 `COURSE_ARCHIVE_BUSY`, with `Retry-After` |
  | More than 10 requests per user per 10 minutes | 429 `RATE_LIMITED` |

- **Scope of the limits:** they apply per API instance, not across instances.
- **Audit:** `course.archive_exported`, with counts and sizes only.
- **UI (AP-038C1E):** **Download with documents** / **Descargar con documentos** sits next to **Export course content** on the course page. Only roles with `content.export` see it.
  - The button is disabled while an archive is prepared.
  - A response that is not a ZIP is reported as a failure and never saved.
  - Errors are localized and follow EN/ES switches.
- **Archive validation (AP-038C2A, backend only, no route yet):**
  - `validateCourseArchive(bytes)` in `apps/api/src/portability/archive-validation.ts` checks an untrusted archive and previews it as a **new draft course**.
  - It never imports, stores or writes anything.
  - **Archive safety:** checked by the inspectors' ZIP scanner, which refuses traversal, absolute paths, duplicates and case collisions, links, special and encrypted entries, forged sizes or CRC, and expansion ratios above 100:1.
  - **Size limits:** at most 25 MB compressed and 45 MB decompressed in total; the manifest at most 1 MiB and `course.json` at most 20 MB.
  - **Layout:** exactly the manifest, `course.json` and `assets/<key>.<pdf|docx|pptx>`.
  - **Manifest:** format and version 1, with canonical asset paths and consistent totals.
  - **Package:** `course.json` must match its manifest size and SHA-256, then pass the AP-038B package validation (including its content hash).
  - **Assets:**
    - the manifest and package must describe the same assets;
    - every asset must be present once, with nothing undeclared;
    - sizes and SHA-256 must match;
    - each file's signature must match its format.
  - Links are never fetched and files are never opened or executed. Full document validation and malware scanning belong to the import.
- **Archive import engine (AP-038C2B, backend only, no route yet):**
  - `importCourseArchive()` in `apps/api/src/portability/archive-import.ts` restores a valid archive as a **new draft course**. It reuses the AP-038B plan and reconstruction and the document upload pipeline.
  - Every activity is created as a draft. Documents are recreated with new identifiers and new stored files, byte-identical to the archive, with their extraction and summary.
  - A document is never marked clean without a scanner.
  - No people or student records are created.
  - **Order of work:**
    1. The caller must be an active administrator.
    2. The whole archive is validated.
    3. Every document is prepared in memory, and its bytes are checked again against the validated SHA-256.
    4. The files are stored and each one is read back to verify it. Each file's key is journaled, with a lease, before the file is written (AP-040R).
    5. One database transaction takes back the import's journal entries (aborting if storage recovery took any), then creates the course, its content and the document records.
    6. If storing or the transaction fails, every file written so far is removed, and its journal entry forgotten.
  - **Crash recovery (AP-040R):** a file that cannot be removed, or files left by a process crash between storing and the commit, are referenced by no record, so they are never served. They stay journaled, and once their lease has run out `pnpm storage:recover` removes them (dry run by default; local only; see docs/storage-integrity.md, section 4). The error reports how many files could not be removed, never their storage keys.
- **Preview API (AP-038C2C):** `POST /api/v1/course-imports/archive/preview`.
  - Administrators only. Authentication, CSRF, Origin and the administrator check happen before the upload is read.
  - `multipart/form-data` with one `file` part: a `.zip` of at most 25 MB. Any other form field is ignored; the report comes from the uploaded bytes only.
  - A read-only dry run: no database or storage write, no course created, nothing executed or fetched.
  - The whole archive is validated in an isolated worker (30 s, 256 MB heap, no network). The worker shares the SCORM and Common Cartridge inspection pool, so one API instance runs at most two package workers of any kind. Only the report leaves the worker.
  - Per API instance: two previews at a time, including uploads waiting for a worker (503 `ARCHIVE_PREVIEW_BUSY`); 10 previews per administrator per 10 minutes (429).
  - An invalid archive gets `200` with `status: invalid`, `preview: null` and stable issue codes (`CourseArchiveIssueCode` in the contract; EN/ES texts in the web catalog). A worker failure or timeout gives `ARCHIVE_VALIDATION_FAILED` or `ARCHIVE_VALIDATION_LIMIT`.
  - Warnings that `course.json` carries from its export are reported only under the known codes, or as `PACKAGE_WARNING`.
- **Preview UI (AP-038C2D):** *Administration → Courses → Import course → Preview a course archive (.zip)* (`/admin/courses/import/archive`).
  - Administrators only; other users see the restricted-page message, and the API refuses them anyway.
  - The browser checks only the file's name, size (25 MB) and that it is not empty, then sends the file as it is. It never reads, unpacks or runs the archive, and it lets go of the file once the report arrives.
  - The report shows: the status; the course's title, description, source code and export date (as written, never translated or rendered as HTML); the counts of units, lessons, quizzes, assignments, documents and questions; what can and cannot be imported; the PDF/Word/PowerPoint files; every issue, described by its code in English or Spanish.
  - There is no import or confirm action yet.
- **Confirmation API (AP-038C2E, feature-gated):** `POST /api/v1/course-imports/archive`.
  - **Off by default.** It answers 403 `ARCHIVE_IMPORT_DISABLED` unless the API runs with `ARCHIVE_IMPORT_ENABLED=true`. That setting is **refused in production** (the API does not start), so it can only be used in local development and tests until the blockers below are resolved.
  - **Access:** administrators only. Authentication, CSRF, Origin and the administrator check happen before the upload is read.
  - **Request:** `multipart/form-data` with the form fields (`programId`, `termId`, `code`, optional `title`, `versionPreference`, `acknowledgeSkipped`, `assignmentDueAt`) and one `.zip` `file` part of at most 25 MiB, in any order (the whole form is read before anything is decided). Any other field is ignored.
  - **Validation:** the archive is validated again in full, in the isolated archive worker (the preview's worker, pool and limits). No earlier preview or client data is trusted. Then the AP-038C2B engine imports it: documents are rechecked, scanned, extracted, stored and read back, then one transaction creates the course.
  - **Response:** 201 with the new draft course and counts.
  - **Errors:** 409 `COURSE_CODE_TAKEN`; 422 `ARCHIVE_IMPORT_INVALID`, `ARCHIVE_IMPORT_DOCUMENT_REJECTED` or the JSON import's placement codes; 503 `ARCHIVE_IMPORT_STORAGE_FAILED` or, with strict malware-scan enforcement, `ARCHIVE_IMPORT_SCAN_UNAVAILABLE`; 500 `ARCHIVE_IMPORT_FAILED`.
  - **Repeats and limits:** a repeated or concurrent confirmation cannot create a second course, because the code must be free in the term. Per instance: one import at a time (503 `ARCHIVE_IMPORT_BUSY`) and 5 imports per administrator per 10 minutes.
- **Production blockers (before `ARCHIVE_IMPORT_ENABLED` may be allowed in production):**
  1. **Orphan recovery in production.** Every import write is now journaled, and `pnpm storage:recover` safely removes the files of interrupted imports (AP-040R, tested with killed processes). It is local-only: nothing runs it in production. Production needs a reviewed production mode with delete access to the bucket, a verified Cloud Storage FUSE check (a cached "not found" must not hide an existing object), an approved way to run it (job or operator session, with its cost approved), and the `0036` migration deployed.
  2. **Malware scanning (AP-040E).** The import scans every document with the same scanner and policy as uploads: an infected document refuses the whole import, and in strict mode so does a document the scanner could not verify (`ARCHIVE_IMPORT_SCAN_UNAVAILABLE`). No scanner runs in production yet (docs/malware-scanning.md), so imported documents would be recorded `not_scanned` (never `clean`).
  3. **Cross-instance limits.** The one-at-a-time cap and the rate limit are per API instance. Several Cloud Run instances multiply them.
  4. **Duration.** Each step is bounded (30 s validation; per-document extraction timeout), but an archive with many documents takes their sum. A per-import document cap or a background job may be needed.
- **Confirmation UI (AP-038C2F):** on the archive preview page, below a valid report.
  - The page asks the API whether import is enabled (`GET /api/v1/course-imports/archive/availability`, administrators only). When it is off, the page explains that import is unavailable and offers no import action.
  - When it is on, the administrator chooses the destination program and term, a new course code, the title, the content version, the assignments' due date and the acknowledgements the archive needs, and confirms that a NEW draft course will be created.
  - A review step shows the destination and the content summary. Only its explicit confirmation sends the checked file with those fields, once per click; the server validates the archive again.
  - Success is shown only after a 201, with a link to the new draft course. A taken code (409) is shown on the code field; other refusals (403, 413, 422, 429, 503) are explained in English or Spanish and follow the language switch.
  - The chosen file (a browser file handle; its bytes are never read by the page) is kept only while the report is shown, and released after the import or when the page is cleared.
  - The browser suite enables the import on its disposable local server only (`e2e/run.sh`).

```text
academiapath-archive.json   manifest: format "academiapath.course-archive", formatVersion 1
course.json                 the JSON export above, byte for byte (still formatVersion 1, bundled: false)
assets/asset-1.pdf          one file per asset, named <asset key>.<format>, never the uploaded file name
```

- **Manifest contents:**
  - `package`: path, format, version, `contentHash`, byte size and SHA-256 of `course.json`;
  - `assets`: each asset's key, path, format, byte size and SHA-256;
  - `totals`: the asset count and the total asset bytes.
  - There is no timestamp, so identical content gives an identical archive.
- **Integrity:**
  - Each file is read through the storage key of a document of this course's own activities.
  - Each file is checked against the database size and SHA-256.
  - A missing, changed or unreadable file fails the whole archive (`ASSET_MISSING`, `ASSET_CORRUPT`, `STORAGE_UNAVAILABLE`). The JSON export instead lists it with a warning.
  - A reference to another course's document is never read; it stays an `INVALID_REFERENCE` warning in `course.json`.
- **Limits:**
  - At most 25 MB (provisional, pending approval before the endpoint exists).
  - The cap is checked from database sizes before any file is read, and again by the ZIP writer.
  - Peak memory is about twice the archive size. Nothing is written to disk.
- **Not scanned:** files are copied as stored. They are not malware-scanned (no scanner is connected; AP-040).

## Warnings

| Code | Meaning |
| --- | --- |
| `ASSET_NOT_BUNDLED` | The package refers to document files that are not included. |
| `ASSET_MISSING` | A document's stored file was not found; only its description is included. |
| `INVALID_REFERENCE` | A reference does not resolve inside the course (for example a document of another course, or an answer key naming a missing option); it is left out. |
| `UNSUPPORTED_ACTIVITY_TYPE` | The activity type is not portable yet; only its title is included. |

## Limits and guarantees

- At most 1000 activities and 20 MB per package; a larger course gets `422 COURSE_EXPORT_TOO_LARGE`, never a partial
  package.
- Read-only: the export reads one consistent snapshot and changes nothing in the course. Each export is audited as
  `course.exported` with counts and the content hash only.
- Stable: the same content always gives the same package (apart from `exportedAt`) and the same `contentHash`.

## Versioning

`formatVersion` changes only when a field changes meaning or a reader could misread the package. New optional fields
may appear within a version; readers must ignore fields they do not know. A reader must refuse a `formatVersion` higher
than it supports.
