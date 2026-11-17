# Common Cartridge inspection (AP-038D)

AcademiaPath can **inspect** an IMS Common Cartridge (`.imscc`), such as a Canvas course export. It reads the package's
structure, then reports what it contains and how each part relates to AcademiaPath.

It does **not** import, store, publish, execute or open the package's content. No course, unit, activity, document or
file is created. The report is only a planning aid for a later import milestone (AP-038E).

- **Who:** the course's design team and instructors, and administrators (permission `content.edit`). Non-editing
  instructors and students get 403. Anyone who cannot see the course gets 404. Anonymous requests get 401.
- **Where:** course page → *Documents* → **Inspect a Common Cartridge** (`/courses/{id}/cartridge-inspection`).
- **API:** `POST /api/v1/courses/{id}/cartridge-inspections`.
  - Request: multipart `file`, `.imscc` or `.zip`, at most 25 MB. It needs a session and the CSRF token.
  - Response: `CartridgeInspectionReport` in `packages/contract/openapi.yaml`, sent with `cache-control: no-store`.
  - `imported` is always `false`.
- **Code:** `apps/api/src/cartridge/`.
  - It reuses the SCORM inspector's hardened ZIP scanner (`scorm/archive.ts`) and bounded XML parser
    (`parseXml` in `scorm/manifest.ts`).
  - It also reuses the shared worker isolation (`workers/isolated.ts`).

## Versions

The version is read from the manifest, never from the file name:

- `<metadata><schema>` and `<schemaversion>`;
- the manifest's default namespace.

| Declared | Result |
| -------- | ------ |
| Common Cartridge 1.0, 1.1, 1.2, 1.3 (`schemaversion` `1.0.0`–`1.3.0`; namespaces `imscc/imscp_v1p1` or `imscp_v1p1` for 1.0, `imsccv1p1`, `imsccv1p2`, `imsccv1p3`) | Inspected. |
| No `schemaversion`, but a known CC namespace | Inspected; version taken from the namespace, warning `CARTRIDGE_VERSION_UNDECLARED`. |
| `schemaversion` and namespace disagree | Inspected using the declared version, warning `CARTRIDGE_VERSION_MISMATCH`. |
| Thin Common Cartridge (`schema` names "Thin") | Inspected; warning `CARTRIDGE_THIN`. Thin cartridges hold links and LTI tools only, not content. |
| Any other CC version (for example 1.4), or an unknown CC namespace | Reported as unsupported (`CARTRIDGE_VERSION_UNSUPPORTED`); the structure is not interpreted. |
| SCORM manifest (ADL namespaces or `ADL SCORM`) | `CARTRIDGE_IS_SCORM`: use *Inspect a SCORM package* instead. |
| Plain IMS content package or other XML | `CARTRIDGE_NOT_CARTRIDGE`. |

**Verification limit.**
- The official 1EdTech specification pages and XSDs were not reachable from the development environment.
- The namespace and resource-type strings above follow the published Common Cartridge profile naming (`imsccv1pN`,
  `imsdt_xmlv1pN`, `imswl_xmlv1pN`, `imsbasiclti_xmlv1p0`, `imsqti_xmlv1p2/imscc_xmlv1pN/assessment`,
  `associatedcontent/imscc_xmlv1pN/learning-application-resource`).
- They were checked against synthetic fixtures only.
- The manifest is **not** validated against the XSDs. The inspector does not claim conformance with any profile.
- Before AP-038E, confirm the strings against the 1EdTech documents. Also run the inspector on real Canvas exports,
  with the owner's authorization (see the prerequisites).

## What is checked

| Area | Checks |
| ---- | ------ |
| Archive | The same rules as SCORM inspection (see `docs/scorm-inspection.md`). Valid ZIP, at most 25 MB and 10,000 entries. Per-file and total decompressed limits (100 MB / 250 MB) and a 100:1 expansion ratio. Each entry is decompressed once in memory to check its real size and CRC-32. No traversal (`..`), absolute paths, drive letters, control characters, duplicate or case/Unicode-colliding names, symbolic links, special files, encrypted entries or unsupported compression. An empty archive is refused. |
| Manifest | `imsmanifest.xml` at the root (nested ones are reported), at most 2 MB, UTF-8/UTF-16/Windows-1252. Strict parsing: a DOCTYPE is refused, so no entity is declared or expanded (no XXE, no "billion laughs") and nothing external is loaded. At most 64 levels deep, 50,000 elements and 64 attributes per element. |
| Descriptors | XML and HTML files the report needs (QTI, discussions, web links, LTI links, Canvas settings, pages). Each is read only if it is at most 1 MiB, with 24 MiB in total. Each XML file goes through the same strict parser. Larger files are counted but not read (`CARTRIDGE_DESCRIPTOR_LIMIT`). |
| Organization | One organization. A single root item is unwrapped; its children are the modules. Nested folders are reported (`CARTRIDGE_ORGANIZATION_NESTED`). Items pointing to missing resources are reported (`CARTRIDGE_ITEM_RESOURCE_MISSING`). |
| Resources | Identifiers must be present and unique. `href` and `<file>` references are resolved through `xml:base` as package-relative paths. A missing primary file is an error. A missing secondary file is a warning. Escaping, dangerous (`javascript:`, `data:`, `file:` …) and external addresses are reported. Dependencies must exist. Unknown types are reported. |
| Pages | Only `href`/`src` attributes are read, as text. Broken local references are counted (the first three per page are listed). `$IMS-CC-FILEBASE$` is resolved against `web_resources/`. Canvas link tokens (`$WIKI_REFERENCE$`, `$CANVAS_OBJECT_REFERENCE$`, `$CANVAS_COURSE_REFERENCE$`, `/courses/<n>/`) are counted. External links are counted, **never fetched**. |
| Assessments | Only QTI 1.2 is read. A QTI 2.x assessment is unsupported. Questions are counted, and their types are read from `cc_profile` or Canvas `question_type` metadata. For Canvas quizzes, the `non_cc_assessments/*.qti` file is read. |
| Links | Web links and LTI launch URLs are read as text: `https` maps directly, plain `http` needs review, and other schemes are invalid. They are never opened. |

**Report:**
- Format and version as declared.
- Title, description and language from the LOM metadata (falling back to Canvas `course_settings.xml`).
- Package size and file count.
- Whether this is a Canvas export, with the evidence.
- Counts by kind and classification.
- The outline (modules and items), the resource inventory, the compatibility summary, and errors and warnings with
  stable codes (59 `CARTRIDGE_*` codes, each with English and Spanish text).
- Lists stop at 500 entries and issues at 200, while counts stay complete. Text from the package is cleaned,
  shortened and shown as written (it is never translated).

**Classifications:**

| Classification | Meaning |
| -------------- | ------- |
| Recognized | Understood and used by other content (Canvas settings, images, quiz metadata). It is not a learner-facing item on its own. |
| Potentially mappable | Matches an existing AcademiaPath feature. Still nothing is imported, and a real import may find more work. |
| Needs transformation | Would need conversion before it could exist in AcademiaPath. |
| Unsupported | AcademiaPath has no counterpart today. |
| Invalid | Broken or unsafe (missing primary file, dangerous address, malformed descriptor). |

A recognized type is never reported as importable just because its type is known.

## Safety

- **Isolation:** each inspection runs in a worker thread, with a 30-second time limit, a 256 MB heap limit and
  `fetch` disabled. At most two run at once. A crash or limit returns an `invalid` report, not a server error.
- **No execution, no network:** HTML and scripts are never rendered or run. Links, LTI launch URLs and external
  references are read as text only.
- **Storage:** nothing is written to disk, object storage or the database. The upload and the descriptors are held in
  memory for the request only. The API test suite checks that the database fingerprint and the document storage
  directory are unchanged.
- **Rate limit:** 30 inspections per user per 10 minutes.
- **Logs:** the course, the status and the error count only. The file name and content are never logged.

## Compatibility matrix

How Common Cartridge and Canvas content relates to AcademiaPath today. AcademiaPath has:
- course units (one level, with folders inside units);
- activity types `page`, `file`, `link`, `quiz` and `assignment`;
- quiz question types `single_choice`, `multiple_choice` and `true_false`;
- one discussion forum per course.

`lti` and `scorm` activity types exist in the schema, but LTI and SCORM playback are not built. Nothing below is
implemented by AP-038D.

| Common Cartridge / Canvas content | AcademiaPath counterpart | Label | Notes |
| --------------------------------- | ------------------------ | ----- | ----- |
| Organization: modules (top-level items) | Course units | Directly supported | Titles and order. Canvas module settings (prerequisites, completion requirements, unlock dates, publish state) are not carried. |
| Nested folders inside a module | Unit folders | Requires transformation | Deeper levels would need flattening. |
| Text headers (items without a resource) | — | Requires transformation | No standalone heading item; it could become a folder title or be dropped. |
| `webcontent` HTML page (`wiki_content/`) | Text lesson (`page`) | Requires transformation | The HTML must be sanitized. `$IMS-CC-FILEBASE$`, `$WIKI_REFERENCE$` and Canvas links must be rewritten. Embedded images and files need asset storage. |
| `webcontent` PDF, DOCX, PPTX | Document (`file`) | Directly supported (type only) | Needs portable document assets (AP-038C) or a new upload path. Malware scanning, extraction and review still apply. |
| Other `webcontent` files (images, video, audio, ZIP …) referenced from the outline | — | Requires new functionality | No generic file or media activity. Images used inside pages are "recognized" and travel with the page. |
| QTI 1.2 assessment with only single-answer, multiple-answer and true/false questions | Quiz | Directly supported (question types) | Points, feedback, attempts, time limits and Canvas quiz settings are not read. |
| QTI 1.2 assessment mixing supported and unsupported questions | Quiz | Requires transformation | Unsupported questions would be dropped or rewritten. |
| QTI assessment with only unsupported questions (essay, fill-in-the-blank, matching, numerical, calculated, file upload, dropdowns, pattern match) | — | Requires new functionality | New question types and grading. |
| QTI 2.x assessment | — | Unsupported | Only QTI 1.2 is read. |
| Question bank (`question-bank`) | — | Requires new functionality | No question banks or random selection. |
| Canvas assignment (`learning-application-resource` + `assignment_settings.xml`) | Assignment | Requires transformation | AcademiaPath assignments take text submissions only. File uploads, URL or media submissions, rubrics, points, groups, peer review and due dates need new functionality. |
| Discussion topic (`imsdt`) | Course forum topic | Requires transformation | Becomes a topic in the single course forum. Graded discussions and per-section forums are not supported. |
| Web link (`imswl`), `https` | External resource (`link`) | Directly supported | Plain `http` needs review (`CARTRIDGE_WEBLINK_INSECURE`). Other schemes are invalid. |
| LTI link (`imsbasiclti`) | — | Requires new functionality | LTI is not built. Tool credentials are never in an export. |
| Canvas course settings (`course_settings/`) | — | Recognized only | Title fallback and Canvas detection. Settings, grading schemes, assignment groups, rubrics, outcomes and events are not interpreted. |
| Other Canvas application resources | — | Unsupported | Unless another resource depends on them (then recognized). |
| IWB, EPUB, APIP resources | — | Unsupported | |
| Unknown resource types | — | Unsupported | Reported with `CARTRIDGE_RESOURCE_TYPE_UNKNOWN`. |

The report's **compatibility summary** applies this matrix to the inspected package. It shows one row per content kind
and support level, with counts.

## Canvas-specific structures

**Detected and reported:**
- `course_settings/` (including `course_settings.xml`, `module_meta.xml` and `assignment_groups.xml`);
- `non_cc_assessments/` (Canvas quizzes in Canvas QTI);
- `wiki_content/` and `web_resources/`;
- `assessment_meta.xml` and `assignment_settings.xml`;
- the Canvas namespace;
- Canvas link tokens in pages.

A strong signal (`course_settings/`, `non_cc_assessments/` or the namespace) marks the package as a Canvas export, with
warning `CARTRIDGE_CANVAS_EXTENSIONS`.

**Not interpreted (unsupported Canvas features):**
- module prerequisites, completion requirements and unlock dates;
- assignment groups and weights;
- rubrics;
- due, availability and lock dates;
- late policies;
- outcomes and mastery;
- grading schemes;
- media tracks and captions;
- Canvas question banks;
- Canvas-only question types (see the matrix);
- quiz settings (attempts, time limits, shuffling);
- announcements and calendar events;
- groups;
- external tools and their settings;
- blueprint and sync settings;
- files' visibility and usage-rights metadata.

## Not covered (by design)

- Importing anything (AP-038E).
- XML Schema (XSD) validation and profile conformance.
- Malware scanning of package files (no scanner is connected; see AP-040).
- Opening or checking external links or LTI tools.
- Reading page text for content quality, or translating authored content.

## AP-038E prerequisites (before any import)

1. **Portable document assets (AP-038C).**
   - Version 1 course packages carry document references only (`docs/course-package-format.md`). AcademiaPath cannot
     yet create a document activity from bytes in a package.
   - A Common Cartridge import of PDF, DOCX and PPTX files needs that path, including scanning, extraction and the review
     workflow.
2. **HTML → lesson conversion.**
   - Sanitize page HTML (an allow-list).
   - Rewrite `$IMS-CC-FILEBASE$`, `$WIKI_REFERENCE$` and Canvas object links to AcademiaPath activities.
   - Store embedded images in private storage.
   - Decide what happens to unresolved links.
3. **QTI 1.2 → quiz mapping.**
   - Map single, multiple and true/false answers, correct responses and points.
   - Decide the policy for unsupported questions (drop, convert, or block the quiz).
   - Decide whether new question types or banks are in scope.
4. **Asset storage and cost.**
   - Choose where imported files and images live (the existing private bucket), with quotas.
   - Any increase in Cloud Storage or processing cost needs Claudio Obregón's approval.
5. **Import model.**
   - A preview/confirm flow like AP-038B (`course-imports/preview`), creating a **draft** course only.
   - Every created item starts in review.
   - Idempotency, and a clear list of skipped content.
   - Authorization equal to course creation, plus an audit log.
6. **Verification with real Canvas exports.**
   - Confirm the namespaces and resource types against the 1EdTech specifications.
   - Run the inspector on representative Canvas exports from the university. Real exports may only be used with the
     owner's authorization, and must not be committed or uploaded to shared systems.
   - Measure the worker limits (time, memory, 25 MB) against real export sizes.
7. **Out of scope unless funded separately:**
   - LTI 1.1/1.3 tool launch;
   - rubrics and grading-scheme mapping;
   - module prerequisites and dates;
   - Canvas Commons/Blueprint content.
