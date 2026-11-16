# Document storage integrity (AP-040B)

Uploaded course documents are stored as private files named by a server-generated UUID in `DOCUMENT_STORAGE_DIR`.
In the cloud demo that directory is `/mnt/documents`, where Cloud Run mounts the Cloud Storage bucket
`elearning-514315-academiapath-files`. Each record in `course_documents` keeps the file's size and SHA-256, computed at
upload. The API serves files only through `GET /api/v1/courses/{id}/activities/{activityId}/document/file`, after
its access checks, and only once the size and SHA-256 match.

AP-040B adds three safeguards:

- a storage readiness check;
- explicit errors for missing and corrupt files;
- a read-only consistency audit.

It changes no infrastructure, no Cloud Run configuration and no data.

## 1. Storage readiness

`DOCUMENT_STORAGE_MOUNT_CHECK` selects what the API checks:

| Mode | Default for | Checks | Effect when the check fails |
| ---- | ----------- | ------ | --------------------------- |
| `off` | development and tests | none (the directory is created on first use) | none |
| `report` | **production** (`NODE_ENV=production`) | the directory exists; whether the API can read and write it and whether it is a **mount point** | missing directory: uploads refused with `503 DOCUMENT_STORAGE_UNAVAILABLE`, error logged. Permission denied: `unavailable` logged and reported, but the write itself decides (a failed write is a clean `503`). Not mounted: `degraded`, warning logged. **The API always starts**: the startup check runs in the background and never delays it |
| `enforce` | opt-in only | the same, and the directory must be a mount point | the API **refuses to start** (also if the check does not finish within 10 s); uploads are refused |

`off` is rejected in production. Production also never creates the storage directory. If the mount point is absent,
writes fail rather than landing on the container's own disk, which is wiped on restart.

A directory existing at `/mnt/documents` does not prove the bucket is mounted. The mount check reads `/proc/mounts`
and falls back to comparing the directory's device with its parent's. The same check has guarded the
`academiapath-seed-demo` Cloud Run **job** since AP-025, and it passed there with the bucket mounted. It has **not yet
been observed inside the API service**. Nor has the permission check (`access()`) on the FUSE mount for the API's
non-root `node` user. That is why production defaults to `report`: it never blocks startup, and it refuses uploads
only for a missing directory, which `stat` shows reliably.

**How to see readiness:**

- **Startup log** (Cloud Logging, service `academiapath-api`): one entry with `storage.status`, `storage.directory`,
  `storage.access` and `storage.mount`. The message is one of:
  - "Document storage is ready"
  - "…usable, but no mount was detected…"
  - "…does not look usable…"
  - "Document storage check did not finish within 10 s"

  No path is logged.
- **`GET /api/v1/system/storage`**, for administrators only (others get `403`): returns the same fields and
  `checkedAt`, is checked on each request, and is never cached. It does not return a path, a file name or a count.

### Required production verification before `enforce`

1. After AP-040B is deployed, sign in as an administrator and open `/api/v1/system/storage`, or read the startup
   log entry. Do not use the demo credentials from Secret Manager without authorization.
2. Expected: `"status": "ready"`, `"mount": "mounted"`, `"access": "read_write"`.
   - If it shows `degraded`/`not_mounted` while uploads and downloads work, the detection does not recognise this
     Cloud Run mount. Keep `report` and investigate; do **not** switch to `enforce`.
3. Only after a `ready` result, a reviewed change to `.github/workflows/deploy.yml` may add
   `DOCUMENT_STORAGE_MOUNT_CHECK=enforce` to the API's environment. That is a deploy-workflow change, so it needs
   Sagar's approval and merge. It adds no cost.

## 2. Missing and corrupt files

Access is always checked first. Callers who may not read the document get the usual `401`, `403` (for example
`SECTION_LOCKED`) or `404`, whatever the state of the file. For callers who may read it:

| Situation | Response | Notes |
| --------- | -------- | ----- |
| Stored file absent | `500 DOCUMENT_FILE_MISSING` | |
| Size or SHA-256 differs from the record | `500 DOCUMENT_FILE_CORRUPT` | no byte of the file is sent |
| Storage cannot be read (I/O error) | `503 DOCUMENT_STORAGE_UNAVAILABLE` | can be retried |
| Upload while the storage directory is missing (or, with `enforce`, storage is not ready), or the write fails | `503 DOCUMENT_STORAGE_UNAVAILABLE` | the directory is checked before the upload is read; nothing is created |

Error responses never contain the storage path, the storage key or the file content.

The API logs an error with `courseId`, `activityId`, `documentId` and, for size mismatches, the byte counts. The log
never includes the key or path.

In the web interface, the "Download original" link fetches the file first. On these errors it shows a localized
(EN/ES) message instead of saving an error response as the document. Without JavaScript it is still a plain download
link.

## 3. Read-only consistency audit

```bash
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/<local-db> DOCUMENT_STORAGE_DIR=/abs/local/dir pnpm storage:audit
```

Add `--json` for the machine-readable report: `reportVersion: 1`, `status`, `incompleteReasons`, `counts`, and an
`issues` list capped at 1,000 entries, with `issuesTruncated`.

**What it reports:**

| Finding | Meaning |
| ------- | ------- |
| `missing_file` | a record whose stored file is gone |
| `corrupt_file` | size or SHA-256 differs from the record (`reason`: `size` or `sha256`) |
| `orphaned_file` | a storage file no record refers to, older than the 60-minute grace period |
| recent unreferenced | newer files, counted separately and **not** treated as orphans: an upload writes its file just before its database transaction commits |
| `unrecognized_entry` | an entry that is not a storage file |
| `read_error` | a file or record that could not be read |

Issues carry record IDs and storage keys only: no file names, titles, contents, people or credentials.

**Guarantees:**

- It never deletes, repairs, moves or writes files.
- All database reads run in one `REPEATABLE READ READ ONLY` transaction that is rolled back.
- Records are read in batches of 200, files are hashed as streams four at a time, and the directory is listed as a
  stream, so memory use stays bounded.
- Ctrl-C stops it cleanly. The scan is then reported as `incomplete (interrupted)`.

**Complete versus incomplete:** a scan is `complete` only if every record and every entry was examined. It is
`incomplete` for any of these reasons:

- `interrupted`
- `time_limit`
- `storage_directory_unavailable`: an absent directory is never reported as "every file missing"
- `listing_error`
- `read_errors`
- `database_error`

**Exit codes:**

| Code | Meaning |
| ---- | ------- |
| `0` | complete, no missing, corrupt or orphaned files |
| `1` | complete, with findings |
| `2` | incomplete |
| `3` | refused |

**Local use only.** The command refuses to run, before reading anything, when:

- `NODE_ENV=production`, or `K_SERVICE` or `CLOUD_RUN_JOB` is set;
- `DATABASE_URL` is not a local database (localhost, 127.0.0.1 or ::1; Cloud SQL socket URLs are refused);
- the storage directory is relative, or is `/mnt/documents` or below it.

Test it only with disposable local PostgreSQL and storage.

### Approval required before any production scan

A production scan is **not** possible with this command, and must not be attempted by loosening the guards locally.
It would need, in order:

1. **A reviewed code change** adding an explicit production mode. It would use a dedicated read-only database role
   (`SELECT` on `course_documents`, `activities` and `sections` only) and read-only bucket access
   (`roles/storage.objectViewer` on the documents bucket only, not the runtime service account's `objectAdmin`).
   **Sagar's** review and merge.
2. **A one-off Cloud Run job**, or an approved operator session, that mounts the bucket **read-only** and connects
   through the Cloud SQL connector with that role and no write credentials. This creates cloud resources, so it needs
   **Sagar's authorization** and **Claudio Obregón's** approval: the job run, the Cloud Storage reads (Class B
   operations and egress for hashing every file) and Cloud SQL load are billable.
3. **A scheduled window outside the demo** (not near November 20, 2026), because hashing every file reads the
   whole bucket.
4. **Handling of the report** as internal data. It lists record IDs and storage keys only. Findings are **reported,
   not repaired**: restoring or removing files is a separate, approved operation.

## Known unresolved risks (not fixed in AP-040B)

- **Placeholder malware scanner.** `noMalwareScanner` records uploads as `not_scanned`. A real scanner needs a
  separate decision and may add cost.
- **Cloud Storage IAM is broader than needed.** `academiapath-runtime` holds project-wide `roles/storage.objectAdmin`
  (see `infra/README.md`, "Next steps"). It should be scoped to the documents bucket.
- **No retention or deletion policy** for stored documents, and no object versioning or soft-delete policy has been
  confirmed, so a deleted or overwritten object may be unrecoverable.
- **Mount detection not yet verified in the API service** (see section 1). Until then production runs in `report`
  mode, so an unmounted volume is reported but not prevented at startup. Writes into an absent mount point still
  fail.
- **Orphans after failed uploads.** If an upload's database transaction fails, the API removes the file it has just
  written. If that removal also fails, the file remains, and nothing cleans it up automatically. The audit reports it
  as orphaned once the grace period has passed.
