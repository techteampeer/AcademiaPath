# Course package format, version 1 (AP-038A)

A course package is the portable copy of one course's reusable content. AP-038A delivers the **export** only:
`GET /api/v1/courses/{id}/export` returns one JSON document, saved as `course-<code>.academiapath.json`. Importing a
package (AP-038B) is not built yet. The authoritative schema is `CoursePackage` in `packages/contract/openapi.yaml`.

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

## Identifiers and how an import will remap them

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

An import (AP-038B) should:

1. Check `format`, `formatVersion` and `contentHash`, and refuse a package it cannot read.
2. Create the course in the target institution's own program and term, with a new code.
3. Create rows in order (units, folders, activities, questions), keeping a map from each key to the new row id, then
   resolve references through that map: prerequisites, folders and assets. Unknown keys are refused.
4. Generate new option and criterion ids, and rewrite answer keys through the option-key map.
5. Import content as **drafts** that go through the target institution's own review, whatever `reviewStatus` says;
   the approved version is reference material, not an approval.
6. Ask staff to set new due dates (`dueAt`, `lateUntil` belong to the source term).

## File assets (limitation)

Version 1 describes each document (`fileName`, `format`, `byteSize`, `sha256`) but does not include its bytes
(`bundled: false`, warning `ASSET_NOT_BUNDLED`). Uploaded documents live in the institution's private storage (a Cloud
Storage bucket mounted by the API); moving them needs a ZIP package and an upload path on the target side, which is
AP-040 work. Until then a document activity is portable as a reference only: an importer must obtain the file
separately and can verify it with `sha256`. A file missing from storage is reported as `ASSET_MISSING`.

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
