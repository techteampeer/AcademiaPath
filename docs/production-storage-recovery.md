# Production storage recovery: readiness and design (AP-OPS-01)

**Status:** design and local verification only. Production recovery is **not** active. Nothing in production has been
changed, and no production file has been deleted. Activating recovery needs the changes and approvals listed below.

## 1. What exists today (verified on `main` at `0b94b6d`)

- **The journal is written.** Every document file written by an upload (`document_upload`) or an archive import
  (`archive_import`) is journaled first, with a 30-minute lease, in `document_storage_intents` (migrations `0036` and
  `0037`, deployed with #74). Each writer takes its entry back in the same transaction that creates the document.
  Files left by a crash or by a failed clean-up stay journaled.
- **Recovery decides from the database:**
  - `storage:recover`, in `src/documents/storage-recovery.ts`, only touches entries whose lease has expired by the
    database clock, one entry per transaction.
  - Each entry is locked with `FOR UPDATE SKIP LOCKED`, so concurrent workers and committing writers are safe.
  - A file that `course_documents` refers to is never removed.
  - Removal and the deletion of the entry happen in one commit, with an audit event. A crash rolls back, and reruns
    are idempotent.
  - Recovery is a dry run by default, and the command refuses production.
- **The audit only reads:** `storage:audit` lists orphans; it is read-only and local-only.
- **Production storage** is the bucket `elearning-514315-academiapath-files`, mounted at `/mnt/documents` in the API's
  Cloud Run service through Cloud Storage FUSE. `deploy.yml` passes no mount options, so the defaults apply.
- **Identity:** the API runs as `academiapath-runtime`. That account holds project-wide `roles/storage.objectAdmin`,
  which `infra/README.md` already flags for removal. Database access is one `DATABASE_URL` secret.

**Nothing removes production orphans today.** They are unreferenced and never served, but they stay in the bucket and
in the journal.

## 2. Local storage versus the production bucket

| Topic | Local disk (tests) | Production (Cloud Storage through FUSE) | Effect on recovery |
| ----- | ------------------ | --------------------------------------- | ------------------ |
| Visibility and caching | POSIX, immediate | FUSE caches object metadata for 60 s and "not found" results for 5 s by default ([CLI options](https://docs.cloud.google.com/storage/docs/cloud-storage-fuse/cli-options)). The cache is per mount, and other instances' changes are not seen until it expires ([performance guide](https://docs.cloud.google.com/storage/docs/cloud-storage-fuse/performance)). | A cached "not found" can make a present file look missing. |
| Missing-file detection | `stat` is authoritative | `stat` may be answered from the cache. Cloud Storage itself is strongly consistent for read-after-write, read-after-delete and listing ([consistency](https://docs.cloud.google.com/storage/docs/consistency)). | Ask Cloud Storage directly, not the mount. |
| Deletion | `unlink`, idempotent with `force` | `unlink` deletes the object. The exact behaviour with a cached "not found" is **not documented** (an unsupported assumption). The API offers deletes conditional on the generation (`ifGenerationMatch`, a mismatch fails with 412), which are safe to retry ([preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions), [retry strategy](https://docs.cloud.google.com/storage/docs/retry-strategy)). | Delete exactly the generation that was observed. |
| Unmounted storage | the directory is missing (the CLI refuses) | an unmounted mount point can look like an **empty directory** | Every file would look "already removed". See the witness check in §5. |
| Concurrency | one host | up to 3 API instances plus any job. No file locking; the last writer wins ([Cloud Run volume mounts](https://docs.cloud.google.com/run/docs/configuring/services/cloud-storage-volume-mounts)). | Keys are unique random UUIDs, never rewritten. Coordination is the database's row locks, not the file system. |
| Undo | none | soft delete is on by default for buckets, with a 7-day retention, and restores are possible ([soft delete](https://docs.cloud.google.com/storage/docs/soft-delete)). **Whether the documents bucket has it is not verified.** | Gives a rollback for a mistaken deletion, but it must be confirmed first. |

## 3. Safety analysis

1. **Visibility and caching.** No decision to delete depends on the file system: the lease, the lock and the reference
   check are all in PostgreSQL. A stale view can at worst make recovery forget an entry whose object still exists
   (an untraceable orphan). It can never remove a file a document uses. The safeguards in §5 retain and flag such
   cases.
2. **Missing-file detection.** In production, use the Cloud Storage API: `objects.get` metadata returns 200 with a
   generation, 404 for a missing object, and anything else is an error. Do not use FUSE `stat`.
3. **Deletion.** Use `objects.delete` with `ifGenerationMatch` set to the generation just observed. A 404 means
   already gone, and a 412 means changed, so keep the entry and flag it. Deletes are free operations
   ([pricing](https://cloud.google.com/storage/pricing)).
4. **Concurrent instances.** Recovery runs only as a job, never in the API. Workers are serialised per entry by
   `SKIP LOCKED`, and a writer committing a reference blocks on the lock, then aborts (tested).
5. **Active uploads versus expired leases.** The 30-minute lease is renewed with every journaled file. A writer whose
   lease was taken aborts at commit (tested for uploads and imports).
6. **Transaction isolation.** Each entry is handled in READ COMMITTED with a row lock and the reference check inside
   the same transaction. The dry run uses REPEATABLE READ, READ ONLY.
7. **Access and IAM.** Recovery needs object get and delete on the documents bucket only, plus narrow database
   rights. See §6.
8. **Interruption.** A killed recovery rolls back its transaction, and the next run finds the file already gone
   (tested with SIGKILL).
9. **Idempotent retries.** Reruns change nothing more (tested). Generation-conditioned deletes are safe to retry.
10. **Auditability and approval:**
    - every entry handled writes an audit event (`storage.write_recovered` or `storage.write_recovery_failed`), with
      no storage keys;
    - the run's JSON report goes to Cloud Logging;
    - an apply must be approved against a dry run (§6).

## 4. Options compared

| | A. Manual command on an operator machine | **B. Administrative Cloud Run job, run by hand** | C. Scheduled automatic job |
| --- | --- | --- | --- |
| Deletion safety | Same engine; depends on a workstation holding production DB and bucket credentials | Same engine, least-privilege identity inside GCP, each apply approved | Deletes without human review; a bug or misconfiguration deletes repeatedly |
| Complexity | Cloud SQL Auth Proxy, gcloud credentials and the repo on a laptop | One job definition, reusing the release's `migrate` image | B plus Cloud Scheduler, alerting and a kill switch |
| Permissions | A human holds broad production access | A dedicated service account, bucket- and table-scoped | Same as B, but usable unattended |
| GCP changes | None, but credentials leave GCP | 1 job, 1 service account, IAM bindings, 1 secret (restricted DB role) | B plus 1 Scheduler job |
| Cost drivers | None in GCP | Job seconds per run; Class B reads per entry; deletes free; soft-deleted bytes for 7 days | B plus $0.10 per Scheduler job per month beyond the 3 free ([Scheduler pricing](https://cloud.google.com/scheduler/pricing)) |
| Failure and rollback | Ad hoc | Exit codes and reports in Logging; soft-delete restore; delete the job to disable | Needs monitoring before it is safe |

**Recommendation: B.** It is the smallest option that keeps credentials inside GCP, uses a narrow identity and keeps
a human approval on every deletion. A (credentials on a workstation) and C (unattended deletion) are not justified
for the small volume expected: orphans come only from crashes and failed clean-ups.

## 5. Safeguards added in this milestone (local, tested)

`storage-recovery.ts` now refuses to forget what it cannot prove:

- **Verified removal.** After a removal, the store must no longer show the file. If it still does (a removal that
  didn't take effect, or a stale or inconsistent view), the entry is **kept**. The run records `STILL_PRESENT`, counts
  the attempt, writes a failure audit event and makes the run incomplete (exit 2).
- **Storage witness.** Before a dry run or an apply, the store must show at least one of the files that the three most
  recent documents refer to. If it shows none (an unmounted bucket, a wrong directory or bucket), the run plans and
  does **nothing** and reports `storage_unverified`. A fresh system without documents has nothing to check against.
- **Tests:** two regression tests in `test/documents/storage-recovery.test.ts`. Removing either safeguard makes them
  fail.
- **Coverage already in place:** expired and active uploads, referenced files, interrupted ZIP imports, failed
  removals, missing files, concurrent workers, SIGKILL during recovery and repeated runs
  (`storage-recovery.test.ts`, `upload-recovery.test.ts`).

## 6. Required for production activation (next milestone; not built)

**Code:**

1. **A Cloud Storage API adapter** implementing `exists` and `remove`:
   - `objects.get` returns 200 with a generation, or 404, and throws on anything else;
   - `objects.delete` uses `ifGenerationMatch` with the observed generation;
   - it gets an access token from the Cloud Run metadata server, so no new dependency and no mount.
2. **A production mode for `storage:recover`**, replacing the local-only refusal:
   - an explicit setting, plus a bucket name, instead of a directory;
   - the dry run prints a plan digest: a SHA-256 over the abandoned entries' IDs and keys;
   - `--apply --approve <digest>` acts only if the current plan still matches. Otherwise it refuses, and a new
     dry run and approval are needed.
3. **Optionally, a production mode for `storage:audit`** that lists objects through the API, to find orphans written
   before the journal existed. It would be read-only.

**IAM (least privilege), for a new service account `academiapath-recovery`:**

- Cloud Storage: `roles/storage.objectUser` on the documents bucket only (it includes `storage.objects.get` and
  `delete`; [roles](https://docs.cloud.google.com/iam/docs/roles-permissions/storage)). A custom role with only `get`
  and `delete` is narrower still.
- Cloud SQL: `roles/cloudsql.client`, plus a dedicated database role allowed to:
  - SELECT on `document_storage_intents` and `course_documents`;
  - UPDATE and DELETE on `document_storage_intents`;
  - INSERT on `audit_log`.

  Its URL is stored in its own Secret Manager secret, readable only by this account.
- Operators: only the permission to execute that one job (`run.jobs.run` on the job). Nobody receives the service
  account's key.
- Separately, remove the runtime account's project-wide `objectAdmin`; that is already an open item.

**Approval, monitoring and audit:**

- Every apply needs Sagar's authorization, given against a dry-run report and its plan digest. Creating the job, the
  service account and the secret needs Claudio's cost approval.
- Exit codes:

  | Exit code | Meaning | Action |
  | --- | --- | --- |
  | 0 | nothing left to do | none |
  | 1 | entries are pending | needs an approved apply |
  | 2 | failures, `STILL_PRESENT` or `storage_unverified` | investigate before any rerun |
  | 3 | refused | — |

- Audit events stay in `audit_log`, and the job's JSON reports stay in Cloud Logging.
- Watch the number of expired journal entries (a dry run, or `SELECT count(*) FROM document_storage_intents WHERE
  lease_expires_at < now()`).

## 7. Cost implications (Claudio's approval needed for the new resources)

| Cost driver | Expected cost |
| --- | --- |
| Cloud Run job | billed only while it runs, with a 1-minute minimum per instance ([pricing](https://cloud.google.com/run/pricing)). A run of under a minute at 1 vCPU and 512 MiB costs a fraction of a cent, likely within the free tier. |
| Cloud Storage | one Class B read per entry ($0.0004 per 1,000 for Standard); deletes free; soft-deleted bytes billed for the retention period (7 days by default). |
| Secret Manager | one new secret (the restricted database URL): an active-version charge per month, plus negligible accesses. |
| Image | none: the job reuses the `migrate` image already built by every release. |
| Logging | within the free allotment for a few runs. |
| Cloud Scheduler | none (option B). |

## 8. Deployment and rollback (when approved)

**Deployment:**

1. Merge the adapter and the production mode, reviewed by Sagar. Merging deploys them, but production stays inactive
   until steps 2–4 are done.
2. **Read-only checks by an authorized operator:**
   - `gcloud storage buckets describe` the documents bucket: soft delete and its retention, and object versioning;
   - the count of expired journal entries.
3. **Create the infrastructure** (Claudio and Sagar approval): the service account, the bucket-scoped role, the
   database role and its secret, and the Cloud Run job `academiapath-storage-recover`. The job uses the `migrate`
   image, the Cloud SQL connector and no bucket mount, and has `--max-retries=0`.
4. **First run:** execute a dry run, review the report and its digest, then execute an apply with `--approve <digest>`
   (Sagar). Confirm exit code 0 and the audit events.

**Rollback:**

- To stop: delete or disable the job, and revoke the account's roles.
- To undo a mistaken deletion within the soft-delete retention: restore that object generation. Its journal entry and
  audit event identify it.
- Database changes are journal deletions and audit inserts only. They are restorable from Cloud SQL backups, but the
  journal is not needed once its files are gone.

## 9. Remaining risks

- **Unverified bucket settings.** Whether the documents bucket has soft delete or versioning is unknown. Without them,
  a deletion is final.
- **A deleted-then-revived writer.** A writer stalled for more than 30 minutes between journaling and writing, whose
  entry is recovered and which then writes and crashes before its own clean-up, leaves an untraceable file. This is
  rare (two failures), and the read-only audit can find such files.
- **Pre-journal orphans.** Files written before `0036` and `0037` are not journaled. Only an approved production
  audit can list them.
- **FUSE semantics.** Deleting through the mount is not documented in enough detail. That is why §6 uses the API.
- **Stray workers.** The storage witness checks once per run, so a mount lost mid-run is caught only by the
  post-removal check of each entry. The API adapter removes the mount from the picture.
- **Production permissions.** The runtime account's project-wide `objectAdmin` stays an exposure until it is removed.

**Ready for production activation: NO.** It needs the adapter, the production mode with plan approval, the IAM and
infrastructure above, the bucket checks, and Sagar's and Claudio's approvals.
