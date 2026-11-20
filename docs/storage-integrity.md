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
| `report` | **production** (`NODE_ENV=production`) | the directory exists; whether the API can read and write it and whether it is a **mount point** | missing directory: uploads refused with `503 DOCUMENT_STORAGE_UNAVAILABLE`, error logged. Permission denied: `unavailable` logged and reported, but the write itself decides (a failed write is a clean `503`). Directory exists but is not a mount: `degraded`, warning logged, **uploads are still accepted** (see "Limitation of `report` mode"). **The API always starts**: the startup check runs in the background and never delays it |
| `enforce` | opt-in only | the same, and the directory must be a mount point | the API **refuses to start** (also if the check does not finish within 10 s); uploads are refused |

`off` is rejected in production. Production also never creates the storage directory. If the mount point is absent,
writes fail rather than landing on the container's own disk, which is wiped on restart.

A directory existing at `/mnt/documents` does not prove the bucket is mounted. The mount check reads `/proc/mounts`
and falls back to comparing the directory's device with its parent's. The same check has guarded the
`academiapath-seed-demo` Cloud Run **job** since AP-025, and it passed there with the bucket mounted. It has **not yet
been observed inside the API service**. Nor has the permission check (`access()`) on the FUSE mount for the API's
non-root `node` user. That is why production defaults to `report`: it never blocks startup, and it refuses uploads
only for a missing directory, which `stat` shows reliably.

### Limitation of `report` mode (storage readiness: PARTIAL)

In `report` mode, a `DOCUMENT_STORAGE_DIR` that **exists but is not a mount** still accepts uploads. Two examples:

- Cloud Run created `/mnt/documents` but the bucket is not mounted there. How Cloud Run behaves when a Cloud Storage
  volume fails to mount has not been verified.
- The setting points at another writable directory.

Such files are written to the instance's own filesystem. On Cloud Run that filesystem is in memory, so the files:

- are lost when the instance stops;
- are invisible to other instances, where downloads fail with `DOCUMENT_FILE_MISSING`.

The only safeguards in `report` mode are:

- the startup warning "Document storage is usable, but no mount was detected at its directory";
- `"status": "degraded", "mount": "not_mounted"` at `GET /api/v1/system/storage`.

This is not a regression: `main` before AP-040B accepted the same uploads with no check and no warning.

Only `enforce` refuses these uploads. It must not be enabled before the verification below. If mount detection
wrongly answered `not_mounted` on the real Cloud Run mount, `enforce` would refuse every upload and stop the API from
starting.

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

This is the exact requirement for closing the `report`-mode limitation. It needs no new resources, no storage scan
and no write to the bucket.

1. Once AP-040B is deployed (with Sagar's authorization), sign in to the production web URL with an administrator
   account and open `/api/v1/system/storage`. Do not read or use the demo credentials from Secret Manager without
   authorization.
2. Alternatively, read the `academiapath-api` startup entries of the new revision in Cloud Logging. Every instance
   logs one when it starts.
3. Required result: `"mountCheck": "report"`, `"status": "ready"`, `"directory": "present"`, `"access": "read_write"`
   and `"mount": "mounted"`. The startup log entry must say "Document storage is ready", with `storage.mount` set to
   `mounted`.
4. If the result is `degraded` / `not_mounted` while the seeded documents still download, the detection does not
   recognise this Cloud Run mount. Keep `report`, do **not** switch to `enforce`, and investigate the mount table
   inside the service. If the documents also fail to download, the bucket really is not mounted: treat it as an
   incident and stop uploads.
5. Only after a `ready` / `mounted` result, a reviewed change to `.github/workflows/deploy.yml` may add
   `DOCUMENT_STORAGE_MOUNT_CHECK=enforce` to the API's environment. That is a deploy-workflow change, so it needs
   Sagar's approval and merge. It adds no cost.
6. After that deploy, confirm `/api/v1/system/storage` shows `"mountCheck": "enforce"` and `"status": "ready"`.

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

## 4. Crash recovery of archive import writes (AP-040R)

A file write and a database commit cannot be atomic, and a process can be killed between them (a stopped container,
an out-of-memory kill), so try/catch clean-up is not enough. Course archive imports therefore keep a **write-ahead
journal**, the `document_storage_intents` table (migration `0036_storage_write_intents`):

1. Before each file is written, the import chooses its storage key and journals it in its own committed statement,
   with a **lease** (30 minutes). Journaling a file also renews the lease of the import's earlier files, so a slow
   but living import never looks abandoned.
2. The file is written under that key (`DocumentStorage.put(bytes, key)`; never over an existing file).
3. The import's database transaction first deletes its own journal entries. If any is missing (recovery took it
   after its lease ran out), the import aborts instead of referring to a file that may be gone.
4. A handled failure removes the import's files and then forgets their entries. Entries of files it could not remove
   stay journaled.

Anything still journaled after its lease has run out belongs to a writer that died or could not clean up.

```bash
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/<local-db> DOCUMENT_STORAGE_DIR=/abs/local/dir pnpm storage:recover            # dry run
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/<local-db> DOCUMENT_STORAGE_DIR=/abs/local/dir pnpm storage:recover -- --apply  # recover
```

**Dry run** (default) lists every journal entry and what recovery would do, in a `READ ONLY` transaction:

| Action | Meaning |
| ------ | ------- |
| `wait_active_lease` | the writer may still be running: never touched |
| `remove_file` | abandoned, no document refers to it, the file is present |
| `forget_entry_file_missing` | abandoned, the file was never written or is already gone |
| `forget_entry_file_referenced` | a document refers to the file: the file is kept, only the entry goes |

**`--apply`** handles each abandoned entry in its own transaction that holds the entry's row lock
(`FOR UPDATE SKIP LOCKED`) and checks the lease again:

- a file a document refers to is kept (`file_kept_referenced`);
- otherwise the file is removed (`file_removed`, or `file_already_missing`), the entry is deleted and a
  `storage.write_recovered` audit event is written, all in one commit;
- a failed removal keeps the entry, increments `attempts`, stores the error code (`EIO`, or `UNKNOWN`, never a message
  or path) and writes a `storage.write_recovery_failed` audit event; the next run retries it;
- an entry that another recovery, or a committing import, holds is skipped (`skipped_concurrent`).

A crash during recovery rolls its transaction back: the entry stays, and the next run finds the file already gone.
Running it again, or several at once, is safe. Audit events hold the journal entry ID, the import's operation ID,
the outcome and an error code: no storage key, path, file name or content. The command's own report (never an API
response) lists storage keys for the operator.

**Exit codes:** `0` nothing left to do; `1` a dry run found abandoned entries; `2` failures or an incomplete run;
`3` refused. It refuses exactly what the audit refuses (section 3), and also a storage directory that does not exist
(an unmounted bucket would make every file look already removed).

**Not covered:** document uploads (a single file per request) are not journaled. Their crash or failed-removal
orphans, and any file written before the journal existed, are reported by `pnpm storage:audit` only.

**Production:** nothing runs recovery automatically, and the command refuses production. Recovering the production
bucket needs the same approvals as a production scan (section 3), plus delete access, which the read-only scan does
not have: a reviewed production mode, an approved job or operator session, **Sagar's authorization** and
**Claudio Obregón's** approval for its cost. Before that, verify Cloud Storage FUSE behaviour for recovery: a cached
"file not found" answer must not make an existing object look already removed (check the object through the Cloud
Storage API, or disable the negative stat cache for that job).

## Known unresolved risks (not fixed in AP-040B)

- **No malware scanning in production.** A ClamAV (clamd) integration exists (AP-040E, docs/malware-scanning.md),
  but it is off by default and not deployed, so production uploads are still recorded as `not_scanned`. Activating it
  needs more Cloud Run resources (a sidecar) and approval.
- **Cloud Storage IAM is broader than needed.** `academiapath-runtime` holds project-wide `roles/storage.objectAdmin`
  (see `infra/README.md`, "Next steps"). It should be scoped to the documents bucket.
- **No retention or deletion policy** for stored documents, and no object versioning or soft-delete policy has been
  confirmed, so a deleted or overwritten object may be unrecoverable.
- **Mount detection not yet verified in the API service** (see section 1). Until then production runs in `report`
  mode. An existing but unmounted storage directory is reported (warning log, `degraded`) but **still accepts
  uploads** into the instance's temporary in-memory storage. A storage directory that does not exist refuses uploads.
- **Orphans after failed uploads.** If an upload's database transaction fails, the API removes the file it has just
  written. If that removal also fails, or the process dies between the write and the commit, the file remains, and
  nothing cleans it up automatically. The audit reports it as orphaned once the grace period has passed. (Archive
  imports are journaled and recoverable, section 4; uploads are not.)
