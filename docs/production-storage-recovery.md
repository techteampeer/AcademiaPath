# Production storage recovery: design, approval workflow and activation plan (AP-OPS-01, AP-OPS-02)

**Status:** production recovery is **not** active and cannot be activated by merging this code.

- **AP-OPS-01** designed recovery and added two local safeguards (§5).
- **AP-OPS-02** adds a Cloud Storage API adapter and a two-stage, approval-based recovery (§6). Both are tested only
  against a local, simulated Cloud Storage API with a disposable database and synthetic files.

Nothing in production has been changed, and no production file has been read or deleted. Activation is a separate,
reviewed change with the infrastructure and approvals in §7–§9.

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
   rights. See §7.
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

## 5. Safeguards added in AP-OPS-01 (local, tested)

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


## 6. Approval-based recovery through the Cloud Storage API (AP-OPS-02: built, disabled in production)

### 6.1 Architecture and security boundaries

| Part | File | Role |
| --- | --- | --- |
| Storage adapter | `apps/api/src/documents/object-store.ts` | `GcsJsonObjectStore`: Cloud Storage JSON API over Node's built-in `fetch`. Separate from the FUSE-backed `LocalDocumentStorage` the API uses. |
| Recovery engine | `apps/api/src/documents/approved-recovery.ts` | `planApprovedRecovery` (stage A) and `applyApprovedRecovery` (stage B). |
| Command | `apps/api/scripts/storage-recover-approved.ts` | `pnpm storage:recover:approved -- plan …` and `-- apply …`; **local emulator only** (§6.6). |
| Simulator | `apps/api/test/helpers/fake-gcs.ts` | A loopback JSON API server backed by a temporary directory, with injectable faults. |

**What the adapter will and will not do:**

- **Two operations only.**
  - Object metadata: `GET …/o/{name}?fields=bucket,name,generation,size`.
  - Generation-matched deletion: `DELETE …/o/{name}?ifGenerationMatch={generation}`.

  It never lists a bucket, never downloads content (`alt=media`) and never deletes without a generation precondition.
- **One bucket and one key namespace.**
  - The bucket and an optional fixed prefix are validated at construction.
  - Object names must be server-generated storage keys (UUIDs), so a path, `..` or any other name is refused
    (`invalid_key`) before any request is sent.
  - The endpoint must be an origin, with no credentials, path or query, and redirects are refused.
  - A metadata answer must name exactly the requested bucket and object, with a valid generation; anything else is
    treated as an error.
- **Exact observations.** `stat` returns either `present` with the live generation, or `missing` for an HTTP 404 only.
  Every other outcome is an `ObjectStoreError` with a distinct kind, and none of them is ever taken to mean "missing":

  | Outcome | Error kind |
  | --- | --- |
  | 401, 403, or no access token | `permission_denied` |
  | client timeout, or 408 | `timeout` |
  | 429, 5xx, or connection failure | `unavailable` |
  | 412 | `precondition_failed` |
  | anything else, including malformed answers | `error` |

- **Injected credentials.** The access token comes from an injected provider.
  - Tests and the local command use a fixed emulator token.
  - `metadataServerToken()` (the Cloud Run metadata server, so no key file) exists for the activation change, but
    nothing uses it in this build.
  - Tokens are never logged.
- **No private keys in output.**
  - Plans, reports, command summaries and audit events identify files by `keyRef`, a one-way SHA-256 of the storage
    key with a fixed domain prefix. Storage keys are random UUIDs, so the hash cannot be reversed by guessing.
  - Plans and reports never contain document names or contents.

### 6.2 Dry run and approval procedure

1. **Plan (stage A, the dry run).** It changes nothing: one REPEATABLE READ, READ ONLY transaction, and metadata reads
   only.
   - It first runs the storage witness (§5). If the store cannot be read or trusted, the plan is `refused`
     (`storage_error` or `storage_unverified`) and proposes nothing.
   - Each journal entry is then classified with the **database clock**:

     | Entry | Plan |
     | --- | --- |
     | lease still running | skipped (`lease_active`) |
     | a document refers to the file | `forget_referenced` (the file is kept) |
     | object present | `delete`, at exactly the generation just observed |
     | object missing (404) | `forget_missing` |
     | any storage error | skipped (`storage_error`), counted as uncertain |

   - The plan records:
     - the environment: the database identity (host, port and name, never credentials), the storage API endpoint and
       the bucket;
     - its creation time, and an expiry from the database clock (60 minutes by default, 1 minute to 24 hours);
     - the counts, the items and the skip reasons;
     - a **digest**: SHA-256 over the canonical form of the format, environment, expiry, status and every item
       (intent ID, operation, `keyRef`, action, generation).
   - The command writes the plan to a new file (never overwriting, mode `0600`). It prints the counts, uncertainty,
     expiry and digest, with no storage keys.
   - Exit code 1 means the plan awaits approval; 2 means it was refused or something is uncertain.
2. **Review.** The approver reads the summary: the counts, the uncertain entries, the bucket and the database. No
   deletion is possible without the next step.
3. **Apply (stage B).** `apply --plan FILE --approve DIGEST` acts only when all of these hold; otherwise it refuses
   and changes nothing:
   - the plan file has exactly the expected shape (`invalid_plan` otherwise);
   - its recomputed digest equals both the digest in the file and the digest typed by the approver (`digest_mismatch`
     otherwise), so a plan edited after approval or another plan's digest is refused;
   - the plan was not refused (`plan_refused`);
   - it is applied against the same database and API endpoint (`wrong_environment`) and the same bucket
     (`wrong_bucket`);
   - it has not expired by the database clock (`approval_expired`);
   - the storage witness still passes.

**An approval never covers anything new.** Apply handles only the entries listed in the plan, each one only at its
planned generation and only for its planned action. A file uploaded after the plan, a rewritten object (a new
generation) and an entry whose lease was renewed are therefore never deleted under an old digest.

### 6.3 What apply checks for each item

Items are handled in intent-ID order, **one transaction each**:

1. Lock the journal entry (`FOR UPDATE SKIP LOCKED`). The lock is taken only while the entry's lease is still expired
   and the approval still valid, both judged by the database clock. Otherwise the item is reported as
   `skipped_lease_active`, `skipped_approval_expired`, `skipped_locked` (another job holds it) or `skipped_entry_gone`.
2. The entry's key and operation must still match the plan (`skipped_state_changed`).
3. Recheck the references inside the same transaction.
   - A `forget_referenced` item is forgotten only if the file is still referenced; its file is kept.
   - A file that a document refers to **now** is never deleted or forgotten (`skipped_now_referenced`).
4. Read the object's metadata. Any storage error fails the item with its code (`PERMISSION_DENIED`, `TIMEOUT`,
   `UNAVAILABLE`, `ERROR`).
5. If the live generation differs from the planned one, the item fails with `GENERATION_CHANGED`, and no deletion is
   even attempted.
6. Delete with `ifGenerationMatch` set to the planned generation. A 412 (changed in the meantime) fails the item with
   `GENERATION_CHANGED`.
7. Verify: the object must now be missing. If not, the item fails with `STILL_PRESENT` (same generation) or
   `GENERATION_CHANGED`.
8. In the same commit, delete the journal entry and write the audit event.

A `forget_missing` item is forgotten only if the object is still missing; a file that has reappeared needs a new
plan. When any item fails, the run is `incomplete` (exit 2), the entry is kept with `attempts`, `last_error` and
`last_attempt_at` updated, and a failure audit event is written.

### 6.4 Audit events

Both events are written in the same transaction as the journal change. The `entity` is the journal entry
(`document_storage_intent`, its ID), and the actor is the system.

| Event | When | `after` holds |
| --- | --- | --- |
| `storage.write_recovered` | an item is done | `outcome` (`file_removed`, `file_already_missing` or `file_kept_referenced`), `mode: approved`, `planDigest`, `generation` |
| `storage.write_recovery_failed` | an item fails | `outcome: failed`, `mode: approved`, `planDigest`, `errorCode`, `attempts` |

`before` holds the entry's operation, operation ID, journal time and previous attempts. No event contains a storage
key, a file name or document content.

Refusals of a whole plan or apply change nothing, so they write no audit row. They are reported by the exit code and
the command's report, which in production would go to Cloud Logging. The identity that ran a production job
execution is recorded by Cloud Audit Logs (§7.4).

### 6.5 Retry and crash behaviour

| Situation | Outcome | How it is retried |
| --- | --- | --- |
| a timeout, unavailability or permission error | the entry is kept with its error code and attempts | re-apply the same plan before it expires, or make a new plan |
| `GENERATION_CHANGED` or `STILL_PRESENT` | the entry is kept and flagged | **investigate**; only a new plan, with a new approval, can act on it |
| a database error | the item's transaction rolls back (`DATABASE_ERROR`) | re-apply |
| locked by another job | `skipped_locked`; the other job handles it once | nothing to do |
| a crash after the deletion but before the commit | the transaction rolls back, so the entry and audit are untouched | re-applying the same plan finds the object gone and records `file_already_missing` (tested with SIGKILL) |
| applying the same plan again after it completed | `skipped_entry_gone` for every item; nothing changes | nothing to do |
| concurrent jobs with the same plan | each item is handled exactly once (row locks) | nothing to do |

A generation-matched delete is safe to retry: if the object is already gone, it answers 404, which is reported as
`already_gone`.

### 6.6 Why merging this does not enable production deletion

- **The command refuses unconditionally**, with exit code 3 and before any request, when any of these hold:
  - `NODE_ENV=production`;
  - it runs on Cloud Run (`K_SERVICE` or `CLOUD_RUN_JOB` is set);
  - `DATABASE_URL` is missing or not on the local machine;
  - the storage API URL is not a loopback `http://` address, so the real Cloud Storage API can never be reached.

  There is no setting, flag or environment variable that lifts these refusals.
- **No real credential is obtained.** The command only ever sends the fixed emulator token. `metadataServerToken` is not
  wired anywhere.
- **Nothing else uses this code.** The API server, `deploy.yml` and every workflow are unchanged, and nothing imports
  the adapter or engine except the command and the tests.
- **No infrastructure exists for it.** There is no recovery job, no recovery service account and no recovery secret.
- **Activation is a separate change (§7)** that must replace the refusal and wire a real token provider. It needs
  Sagar's review, the infrastructure in §7, and Claudio's approval for its costs.

### 6.7 Tests

All tests run against a disposable PostgreSQL 16 database, synthetic files and the simulated API. Uploads and archive
imports are killed with SIGKILL.

- **`test/documents/object-store.test.ts`** (5 tests) covers the adapter:
  - metadata only, with credentials;
  - exact-generation deletion;
  - every failure mapped to its own kind, and never to "missing";
  - the bucket and namespace limits;
  - the metadata-server token.
- **`test/documents/approved-recovery.test.ts`** (14 tests) covers the 22 required cases:

  | Case | Test |
  | --- | --- |
  | 1 expired abandoned upload; 5 successful dry run; 6 dry run without approval; 7 correct digest | upload killed after writing |
  | 2 active upload; 12 lease renewed after the dry run | active upload / renewed lease |
  | 3 referenced document; 11 becomes referenced after the dry run | referenced document |
  | 4 interrupted archive import | import killed after two files |
  | 8 incorrect digest (also: no approval, another plan's digest, a tampered plan, malformed plans) | approval |
  | 9 expired or stale approval (also: expiry during a run) | expiry |
  | 10 generation changes between preview and deletion (also: between the check and the deletion, giving a 412) | generation |
  | 13 object already missing | already gone |
  | 14 permission denied; 15 network timeout; 16 storage API unavailable | failures |
  | 17 concurrent recovery jobs | concurrency |
  | 18 crash after deletion before the journal update; 19 repeated recovery | SIGKILL during apply |
  | 20 attempted access to a different bucket (also: another endpoint or database) | environment |
  | 21 production execution still refused | command refusals and the local happy path |
  | 22 no deletion when storage observations cannot be trusted (unverified storage, a deletion that did not take effect) | untrusted storage |

- **Mutation proofs.** Twenty guards were removed one at a time, and each removal made at least one of these tests
  fail. Every mutation was restored, and the files were verified by checksum. The guards:
  - the generation precondition;
  - the generation comparison;
  - the digest checks, the typed approval, and the generation's place in the digest;
  - the up-front and per-item expiry checks;
  - the lease recheck and the reference recheck;
  - storage errors treated as missing, both at apply time and in the adapter (HTTP errors, network errors);
  - the bucket check and the database-identity check;
  - the storage witness and the post-deletion verification;
  - the adapter's key-namespace and response-identity checks;
  - the command's production and Cloud Run refusals.

  The command's local-database and loopback-URL refusals were deliberately **not** mutated: removing them would make
  the test contact a remote host.

### 6.8 Dependencies

None were added. The adapter calls the documented Cloud Storage JSON API (the interface the official client library
wraps) with Node 22's built-in `fetch`. Only two calls are needed (object metadata and a conditional delete), so the
official `@google-cloud/storage` client and its transitive dependencies would add supply-chain surface for no
functional gain. Tokens come from the documented metadata-server endpoint, so there is no key file and no auth
library.

## 7. Production activation (separate change; not built; needs approvals)

### 7.1 Code changes for activation (a separate pull request)

1. **A production mode for the command, replacing the unconditional refusal.**
   - It runs only as the dedicated Cloud Run job (§7.4), against the real JSON API, with `metadataServerToken`.
   - It is enabled by an explicit setting present only on that job.
   - The bucket is fixed by the job's configuration, not by the operator.
2. **Plan storage.** A Cloud Run job has no persistent disk, so the plan file cannot be carried from the plan execution
   to the apply execution.
   - Proposal: an insert-only `storage_recovery_plans` table (a new migration) holding each plan by its digest.
   - `apply --approve DIGEST` would then load the plan from the database, where it was written by the plan execution.
3. **Reports to Cloud Logging** as JSON, with no storage keys (already the case for the reports).

### 7.2 IAM (least privilege)

The dedicated job runs as a new service account, `academiapath-recovery`.

- **Cloud Storage.** A custom role with only `storage.objects.get` and `storage.objects.delete`, bound on the
  documents bucket only. `roles/storage.objectUser` on the bucket is the predefined alternative, but it also allows
  creating and listing objects.
- **Cloud SQL.** `roles/cloudsql.client`, plus the database role in §7.3.
- **Secret Manager.** `roles/secretmanager.secretAccessor` on the one recovery database secret only.
- **Operators.** `run.jobs.run`, plus `run.jobs.runWithOverrides` to pass `plan` or `apply --approve …`, on that job
  only. No one receives a key for the service account.
- **Separately,** remove the runtime account's project-wide `roles/storage.objectAdmin`. This was already an open item
  in `infra/README.md`. Until it is removed, the API's own identity can delete any object in the project.

### 7.3 Database access

The job needs a dedicated database login (not the application's), with only:

| Table | Privileges | Why |
| --- | --- | --- |
| `document_storage_intents` | SELECT, UPDATE, DELETE | UPDATE is also needed for `FOR UPDATE` locks |
| `course_documents` | SELECT | the reference checks |
| `audit_log` | INSERT | the audit events |
| `storage_recovery_plans` | SELECT, INSERT | only if §7.1 item 2 is adopted |

- Its connection URL lives in its own Secret Manager secret, readable only by `academiapath-recovery`.
- Creating that login is a production database change. It needs Sagar's authorization and is **not** part of the
  regular migrations.

### 7.4 Cloud Run job configuration (proposal; do not create without approval)

The job would be named `academiapath-storage-recover`, in `us-central1`, and configured as follows:

- **Image:** the release's `migrate` image, which already contains the API workspace, so no new image is built.
- **Identity:** `academiapath-recovery` (§7.2).
- **Cloud SQL:** the `academiapath-db` connection.
- **Secrets:** `DATABASE_URL` from the recovery secret.
- **Environment:**
  - the activation setting;
  - `STORAGE_RECOVERY_BUCKET=elearning-514315-academiapath-files`.
- **No** bucket volume mount, and no ingress (it is a job).
- **Retries:** `--max-retries=0`. Retrying is a human decision.
- **Sizing:**
  - `--tasks=1 --parallelism=1`;
  - `--task-timeout=10m`;
  - 1 vCPU and 512 MiB.
- **Executions:**
  - `gcloud run jobs execute … --args=plan` for the dry run;
  - `--args=apply,--approve,<digest>` after approval.

Each execution, and the identity that started it, is recorded in Cloud Audit Logs.

### 7.5 Bucket prerequisites: soft delete and versioning

**Not verified. Do not assume either is enabled on `elearning-514315-academiapath-files`.** Before activation, an
authorized operator must read the bucket's settings with `gcloud storage buckets describe
gs://elearning-514315-academiapath-files`. The command is read-only; record `soft_delete_policy` and
`versioning_enabled`. What a deletion means then depends on those settings:

| Bucket setting | A deletion by recovery |
| --- | --- |
| soft delete with a retention period | the object can be restored until that period ends ([soft delete](https://docs.cloud.google.com/storage/docs/soft-delete)) |
| object versioning on | the live version becomes noncurrent; it stays restorable, and billed, until a lifecycle rule or a person removes it |
| neither | **the deletion is permanent; nothing can restore the object** |

If neither protection is on, Sagar must either accept permanent deletion explicitly, or enable soft delete first.
Enabling it is a bucket change with a storage cost for the retention period, so it needs Claudio's approval. No
recovery from a permanent deletion is promised anywhere in this design.

## 8. Cost implications (Claudio's approval needed for the new resources)

| Cost driver | Expected cost |
| --- | --- |
| Cloud Run job | billed only while it runs, with a 1-minute minimum per instance ([pricing](https://cloud.google.com/run/pricing)). A run of under a minute at 1 vCPU and 512 MiB costs a fraction of a cent, likely within the free tier. Two executions per recovery: plan and apply. |
| Cloud Storage operations | each plan and each apply reads metadata once per entry, plus three witness reads. These are Class B operations ($0.0004 per 1,000 for Standard storage). Deletes are free ([pricing](https://cloud.google.com/storage/pricing)). |
| Soft-deleted or noncurrent bytes | deleted orphans stay billed for the soft-delete retention period, or until noncurrent versions are removed. Orphans are rare, so this is small. Enabling soft delete on the bucket, if it is off, applies to **every** deleted object, not only recovery's. |
| Secret Manager | one new secret (the restricted database URL): an active-version charge per month, plus negligible accesses. |
| Cloud SQL | none: no new instance, and one short connection per execution. |
| Image | none: the job reuses the `migrate` image. |
| Logging | within the free allotment for a few runs. |
| Cloud Scheduler | none: runs are manual (option B in §4). |

**Claudio's approval** is needed for:

- the job;
- the service account and its bindings;
- the secret;
- any change to the bucket's soft-delete or versioning settings.

**Sagar's authorization** is needed for:

- the activation pull request (merging deploys);
- the database login;
- every production apply.

## 9. Deployment and rollback (when approved)

**Deployment:**

1. **This change.** Merging deploys nothing new to production behaviour. The command still refuses production.
2. **Read-only checks** by an authorized operator:
   - the bucket settings (§7.5);
   - the count of expired journal entries.
3. **Create the infrastructure** (Claudio and Sagar approval): the service account and its bucket-scoped role, the
   database login and its secret, and the job (§7.2–§7.4).
4. **The activation pull request** (§7.1), reviewed by Sagar. Merging it deploys it.
5. **First run:**
   1. Execute a plan and review its summary and digest.
   2. Sagar approves the digest.
   3. Execute the apply with `--approve <digest>`.
   4. Confirm exit code 0, the audit events, and the per-entry outcomes in Cloud Logging.

**Rollback:**

- **To stop:** remove the operators' `run.jobs.run`, delete the job, or revoke the account's bucket role. Any one of
  these is enough.
- **To undo a mistaken deletion:** possible **only** if §7.5 showed soft delete or versioning. Restore the object
  generation named in the `storage.write_recovered` event. Without either, a deletion cannot be undone.
- **Database:** the changes are journal deletions, attempt counters and audit inserts. They can be restored from Cloud
  SQL backups, but the journal is not needed once its files are gone.

## 10. Remaining risks

- **Unverified bucket settings.** Soft delete and versioning are unknown (§7.5). Until they are checked, every
  deletion must be treated as permanent.
- **A production plan store** (§7.1) is designed but not built. Until it exists, the approval flow has only been
  tested with plan files.
- **A deleted-then-revived writer.** A writer stalled for more than 30 minutes between journaling and writing, whose
  entry is recovered and which then writes and crashes before its own clean-up, leaves an untraceable file. This is
  rare (it takes two failures), and a read-only production audit could find such files; that audit is not built.
- **Pre-journal orphans.** Files written before `0036` and `0037` are not journaled. Only a production listing, which
  is not built and would need approval, can find them.
- **The witness is a sample.** It checks the three most recent documents. A store that shows those files but hides
  others would pass it, but per-item generation checks and post-deletion verification still apply.
- **Simulator fidelity.** The simulated API follows the documented JSON API status codes and generation semantics. It
  is not Google's service, so the adapter is unproven against the real API until the activation run.
- **Production permissions.** The runtime account's project-wide `objectAdmin` remains an exposure until it is
  removed.

**Ready for production activation: NO.** Activation needs:

- the activation change (§7.1);
- the IAM, database login and job (§7.2–§7.4);
- the bucket check (§7.5);
- Claudio's approval for the costs, and Sagar's authorization.
