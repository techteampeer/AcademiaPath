# SCORM package inspection (AP-033B)

AcademiaPath can **inspect** a SCORM package: it checks the package's structure and reports what it found.

It does **not** import, store, publish, launch or play SCORM content. No activity is created, and the package's HTML
and JavaScript are never executed. SCORM playback, learner tracking and grades are later milestones (see the
AP-033A research report).

There are two entry points, which share one validator (`apps/api/src/scorm/`):

- **In the course** (design team, instructors, administrators): course page → *Documents* → **Inspect a SCORM
  package**. API: `POST /api/v1/courses/{id}/scorm-inspections` (multipart `file`, `.zip`).
- **Offline**, for packages received by e-mail (for example Claudio's examples). No server, database or network is
  used:

  ```bash
  pnpm scorm:inspect path/to/package.zip
  ```

  ```bash
  pnpm scorm:inspect --json path/to/package.zip
  ```

  | Exit code | Meaning |
  | --------- | ------- |
  | `0` | Structurally valid (warnings allowed) |
  | `1` | Invalid |
  | `2` | The command could not run: wrong usage, or an unreadable file |

  The command reads only the given file. It never modifies, extracts or uploads it, and never fetches anything the
  package refers to. Its output names the file, never your local folders.

## What is checked

| Area | Checks |
| ---- | ------ |
| Archive | Valid ZIP. At most 25 MB compressed and 10,000 entries. Each file at most 100 MB decompressed, all files at most 250 MB. Expansion ratio at most 100:1 for files over 1 MB. Every entry is decompressed once in memory to verify its real size and CRC-32 (forged sizes and damaged entries are refused). |
| Entry names | No `..`, absolute paths or drive letters, backslashes, control characters, `:` or empty segments. At most 512 bytes and 32 levels deep. No duplicates, and no names that differ only in letter case or Unicode form. |
| Entry types | No symbolic links, devices or other special files. No encrypted entries. Only stored or deflate compression. |
| Manifest | `imsmanifest.xml` at the root, at most 2 MB. Encoding: UTF-8, UTF-16 with BOM, or Windows-1252. Parsed strictly: a DOCTYPE is refused, so no entity is declared or expanded and nothing external is loaded. At most 64 levels deep, 50,000 elements and 64 attributes per element. |
| Standard | SCORM 1.2 (`schemaversion` 1.2) or SCORM 2004 2nd, 3rd or 4th Edition (`CAM 1.3`, `2004 3rd Edition`, `2004 4th Edition`). An undeclared version is inferred from the namespaces, with a warning. Other versions are refused. IMS Common Cartridge files, such as Canvas course exports, are recognised and reported as **not SCORM**. |
| Structure | Organizations and the default organization. Items, their resources and visibility. Unique identifiers. SCO and asset resources. Dependencies. |
| Files | Each launch file and listed file is resolved through `xml:base` as a package-relative path: percent-escapes are decoded, and `..` may not climb above the package. Launch files must exist (an error). Missing listed files are a warning. External (`http:`), dangerous (`javascript:`, `data:`, `file:` …) and escaping addresses are reported. Flash and non-HTML launch files are warned about. |

**Report:**
- Fields: the standard, version and edition; the title; counts of organizations, items, resources, SCOs, assets and files; compressed and verified uncompressed sizes; launchable items with launch paths; resources; and errors and warnings, each with a stable code.
- Bounds: lists stop at 500 entries and issues at 200, while counts stay complete. Text taken from the package is cleaned and shortened.
- Playback: `runtime.playbackAvailable` is always `false`. `plannedSupport` says whether a later milestone is expected to play the package (SCORM 2004 sequencing rules will not be applied).

## Safety

- **Isolation:** each inspection runs in a worker thread, with a 30-second time limit, a 256 MB heap limit and network access disabled. At most two run at once.
- **Rate limit:** 30 inspections per user per 10 minutes.
- **Storage:** nothing is written to disk. Only `imsmanifest.xml` is kept in memory.
- **Logs:** the API logs the course, the status and the error count; it never logs the file name or content.

## Not covered (by design)

- Runtime behaviour: whether the content calls the SCORM API correctly, or saves progress and scores.
- SCORM 2004 sequencing and navigation.
- XML Schema (XSD) validation of the manifest.
- Malware: no scanner is connected (AP-040).

A structurally valid package can still fail at runtime. Test real vendor packages again once playback exists.
