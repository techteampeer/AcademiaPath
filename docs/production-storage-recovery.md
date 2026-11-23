# Production storage recovery: design, approvals and activation plan (AP-OPS-01, AP-OPS-02, AP-OPS-03)

**Status:** production recovery is **not** active and cannot be activated by merging this code.

- **AP-OPS-01** designed recovery and added two local safeguards (§5).
- **AP-OPS-02** added a Cloud Storage API adapter (§6.1).
- **AP-OPS-03** replaces AP-OPS-02's digest-only approval with durable, authenticated and auditable plans and
  approvals (§6.2–§6.9).

All of it is tested only against a local, simulated Cloud Storage API, with a disposable database, synthetic files and
a test identity provider. Nothing in production has been changed, and no production file has been read or deleted.
Activation is a separate, approved milestone (§7–§10).

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
    - a deletion runs only under a durable approval by a verified operator (§6).

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


## 6. Durable, approval-based recovery through the Cloud Storage API (AP-OPS-02 and AP-OPS-03: built, disabled in production)

### 6.1 Architecture and security boundaries

| Part | File | Role |
| --- | --- | --- |
| Storage adapter (AP-OPS-02) | `apps/api/src/documents/object-store.ts` | `GcsJsonObjectStore`: the Cloud Storage JSON API over Node's built-in `fetch`. Separate from the FUSE-backed `LocalDocumentStorage` the API uses. |
| Plan and approval records (AP-OPS-03) | `apps/api/src/db/schema/storage-recovery.ts`, migration `0038_storage_recovery_approvals` | `storage_recovery_plans` and `storage_recovery_plan_entries`, with database guards (§6.3). |
| Lifecycle service (AP-OPS-03) | `apps/api/src/documents/approved-recovery.ts` | Functions to create, review, approve, revoke, claim (or resume) and execute plans. |
| Operator identity (AP-OPS-03) | `apps/api/src/documents/operator-identity.ts` | The trusted identity-provider interface and roles. The only provider shipped, `NO_TRUSTED_OPERATOR_IDENTITY`, rejects every credential. |
| Command | `apps/api/scripts/storage-recover-approved.ts` | `pnpm storage:recover:approved -- preview …`: a read-only preview, **local emulator only**. It has no approve or apply command. |
| Test doubles | `apps/api/test/helpers/fake-gcs.ts`, `test/helpers/operator-identity.ts` | A loopback simulated JSON API with injectable faults, and a signed-token identity provider used only in tests. |

**What the adapter will and will not do:**

- **Two operations only.** It reads object metadata (`GET …/o/{name}?fields=bucket,name,generation,size`) and deletes
  a given generation (`DELETE …/o/{name}?ifGenerationMatch={generation}`). It never lists a bucket, never downloads
  content and never deletes without a generation precondition.
- **One bucket and one key namespace.** Only server-generated storage keys under the configured prefix are accepted.
  The endpoint must be a bare origin and redirects are refused. A metadata answer must name exactly the requested
  object.
- **No failure means "missing".** Only a 404 does. Permission errors, timeouts, an unavailable API, a 412 and malformed
  answers are distinct errors. Access tokens come from an injected provider and are never logged.

**No storage keys anywhere.** Plans, entries, reports, previews and audit events identify files by a one-way
`keyRef` (SHA-256 of the key with a fixed domain prefix). Storage keys are random UUIDs, so the hash cannot be
reversed by guessing. Plan rows never store keys at all: execution reads each key from its journal entry.

### 6.2 Why a digest alone does not authorize anything

AP-OPS-02 accepted a plan file plus its SHA-256 digest as the approval. AP-OPS-03 replaces that. A digest is a
fingerprint of content: anyone who can read a plan can compute it, and it says nothing about who agreed to it. On its
own, a digest:

- is not a secret, so it cannot prove that an operator, rather than the plan's author, chose to approve;
- does not say who approved, so there would be no accountability and no way to enforce that the creator is not the
  approver;
- cannot be revoked: once typed, it would authorize the plan until expiry;
- does not survive in a temporary file in an auditable, tamper-evident way.

**What the digest is still used for:**

- the approver must quote the digest of the plan they reviewed, which confirms that they approve exactly that content;
- every later step recomputes it from the stored rows, so tampering is detected even when the database guards are
  bypassed.

**What authorizes:**

- a verified operator identity with the right role;
- separation of duties: the plan's creator can never approve it;
- the database state machine, with its expiry and revocation;
- a fencing claim for execution.

### 6.3 The approval lifecycle

```
draft ──► awaiting_approval ──► approved ──► applying ──► completed
 (inside the       │                │          │  ▲  │
  creating         │                │          │  │  └──► partially_completed ──► applying (resume)
  transaction)     ▼                ▼          ▼  │
                revoked / expired  revoked / expired   applying (resume after a lapsed claim)
```

| Step | Function | Who | Result |
| --- | --- | --- | --- |
| Create | `createRecoveryPlan` | a verified **planner** | A plan with a database-generated UUID, bound to the environment label, database identity, storage endpoint, bucket and object prefix. It records the exact journal entries and object generations observed, a summary of what was left out and why, an expiry (1 second to 4 hours; default 1 hour) and the creator's verified issuer and subject. Status `awaiting_approval`. |
| Review | `reviewRecoveryPlan` | any verified recovery operator | A read-only view, with the recomputed integrity state (`intact` or `mismatch`). |
| Approve | `approveRecoveryPlan` | a verified **approver** who is not the creator, quoting the reviewed digest | `approved`, with the approver's issuer and subject and the time. Refused if the plan is expired, from another environment, tampered with, quoted with another digest, or the approver is its creator. |
| Revoke | `revokeRecoveryPlan` | an approver, or the plan's creator, with a reason | `revoked`, at any point before the plan is finished, including during execution. |
| Claim or resume | `claimRecoveryPlan` | a verified **executor** | `applying`, with a random fencing token and a short claim lease (1 second to 1 hour; default 5 minutes) renewed with every entry. A plan whose claim lapsed (a crashed worker) or that was left `partially_completed` is resumed; a live claim is never shared. |
| Execute | `executeRecoveryPlan` | the claim holder only | Handles only the plan's own entries (§6.5), then marks the plan `completed`, or `partially_completed` while retryable failures remain. |

Expired, revoked and completed plans are closed: nothing can act on them again.

**Database guards (migration 0038), whatever the connecting role:**

- **Plans.**
  - The contents (binding, summary, creator, times) and, once out of `draft`, the digest can never change.
  - The status follows only the transitions above.
  - An approval, once recorded, never changes.
  - Approving or claiming after the expiry is rejected, and so is marking a plan expired before its expiry.
  - A CHECK constraint forbids the approver from being the creator.
  - Plans can be neither deleted nor truncated.
- **Entries.**
  - Entries can be added only while the plan is a `draft`, which is inside the transaction that creates it, so an
    approved plan can never grow.
  - Their reviewed contents (journal entry, operation, `keyRef`, action, generation) never change.
  - Outcomes can be recorded only while the plan is `applying`, and a finished entry never changes again.
  - Entries can be neither deleted nor truncated.
- **Audit log.** It is append-only (migration 0001).

### 6.4 Trusted operator identity requirements

- **Opaque credentials only.** Every lifecycle function takes an opaque credential and asks an injected
  `OperatorIdentityProvider` to verify it.
  - Only the provider's answer is trusted: its issuer, its subject, and the roles `storage_recovery.planner`,
    `storage_recovery.approver` and `storage_recovery.executor`.
  - No function accepts an operator name, a command-line flag, an environment variable or a caller-built identity
    object.
  - A provider error or a malformed answer is a rejection, and there is no fallback.
- **No production provider.** Because the only provider shipped rejects everything, nothing can be planned, approved or
  executed outside the tests.
- **The tests' provider** (`test/helpers/operator-identity.ts`) issues HMAC-signed tokens with a random per-run key. It
  rejects tokens with a changed subject or roles, another key, another issuer or audience, or a past expiry.
- **What a production provider must guarantee** (for the activation milestone):
  - cryptographic verification of a short-lived credential issued by a trusted authority, bound to a recovery-specific
    audience;
  - a stable, unique subject, not an editable display name or email;
  - roles granted from an authoritative, reviewed source, not from the credential holder;
  - no caching of a rejection as an acceptance, and no logging of credentials.

### 6.5 What execution checks for each entry

Entries are handled in journal-entry order, each **at most once**:

1. **Fence, in a short transaction with no network call.** The plan must still be `applying` under this worker's claim
   token, with the claim live, not revoked and not expired (by the database clock). The claim is renewed. This
   transaction stops a revoked, expired or taken-over run before it reads storage.
2. **Observe the object outside any transaction.** The key is read from the journal entry, then its metadata from
   Cloud Storage.
3. **Decide and act in one short, bounded transaction.**
   1. Lock the plan row, and recheck the fence: a revocation committed meanwhile stops the run here.
   2. Lock the plan entry.
   3. Lock the journal entry (`SKIP LOCKED`), only while its lease is still expired by the database clock.
   4. Check that the entry's key and operation still match the plan.
   5. Recheck the document references.

   Then:

   | Situation | Outcome |
   | --- | --- |
   | `forget_referenced`, still referenced | the entry is forgotten and the file kept |
   | a document now refers to the file | `skipped_now_referenced`; never deleted or forgotten |
   | lease renewed | `skipped_lease_active`; the writer keeps its entry |
   | journal entry gone | `skipped_entry_gone` |
   | held by another worker | left `pending`, retried later |
   | storage error | `failed` (retryable), with its code |
   | object missing | forgotten (`file_already_missing`) |
   | live generation differs from the plan's | `failed_final` (`GENERATION_CHANGED`); **no deletion is even attempted** |
   | same generation | deleted with `ifGenerationMatch`, then verified gone |

   After the deletion:
   - A 412 means the object was replaced in between, so the entry becomes `failed_final` (`GENERATION_CHANGED`).
   - An object still present after deletion becomes `failed_final` (`STILL_PRESENT`).
   - Otherwise, the entry outcome, the deletion of the journal entry and the audit event are committed together.

### 6.6 Transactions and network calls

Every storage read happens outside a transaction: the storage witness, plan observations, and the per-entry
observation (tested: no session is "idle in transaction" while an object is being read). **The only network calls
made inside a transaction** are the generation-matched deletion and its verification read.

**Why this is the smallest defensible design.** Writers (`storage-journal.ts`) renew their leases and commit by
deleting their journal entries; neither step checks any recovery claim. The only thing that stops a writer from
committing a reference to a file in the middle of its deletion is the journal entry's row lock, held across the
deletion. A design with no transaction open across that deletion would need a durable recovery claim that writers
respect in `reserve()` and `settle()`. That is a change to the upload and archive-import write protocol, outside
this milestone; it is the precise blocker to going further.

**These transactions are bounded:**
- the store's per-request timeout (10 seconds by default);
- per-transaction PostgreSQL limits: `lock_timeout` 5 s, `statement_timeout` 15 s and
  `idle_in_transaction_session_timeout` 60 s.

PostgreSQL ends a hung worker's session and rolls it back, which releases its locks. A revocation issued during a
deletion waits at most that long, then takes effect before the next entry (tested).

### 6.7 Expiration and revocation

- **Expiry.**
  - Every plan expires at a fixed time chosen at creation: at most 4 hours, 1 hour by default.
  - Expiry is judged by the database clock at approval, at claim, at every entry and at the end of a run. An expired
    plan is marked `expired` and audited.
  - An expiry during a run stops it before the next deletion (tested).
  - The trigger also rejects any approval or claim after the expiry.
- **Revocation.**
  - It is available to approvers and to the plan's creator, requires a reason, and is recorded with the revoker's
    verified identity.
  - It takes effect atomically: a run checks the plan, under its row lock, before every entry. An entry already being
    deleted finishes, and nothing runs after it.
- **Approvals do not travel.** An approval is valid only for the plan's own binding (environment label, database,
  storage endpoint, bucket, prefix). It is refused anywhere else, at approval, at claim and at execution.

### 6.8 Crashes, retries and concurrency

| Situation | What happens |
| --- | --- |
| a worker dies after claiming | its claim lapses (5 minutes by default), and another executor resumes the plan; the audit names both |
| a worker dies after deleting an object, before committing | the entry's transaction rolls back (the journal entry, plan entry and audit are unchanged). On resume the object is found missing, so the entry is forgotten (`file_already_missing`). Tested with SIGKILL |
| a stale worker wakes after a takeover | its claim token no longer matches: it stops (`claim_lost`) and deletes nothing |
| two executors claim at once | exactly one wins; the others are refused (`in_progress`) |
| a storage error (timeout, unavailable, permission) | the entry is `failed` and kept, with its attempts and error code, on the plan and on the journal entry. The plan ends `partially_completed`, and resuming it before expiry retries only the failed entries |
| `GENERATION_CHANGED` or `STILL_PRESENT` | `failed_final`: kept and flagged for inspection; only a new plan, with a new approval, can act on it |
| a database error | that entry's transaction rolls back and the run stops; resuming retries it |
| a completed plan run again | refused (`completed`); an old claim executes nothing |

### 6.9 Audit events

All events go to the append-only `audit_log`, with a system actor and the verified operator (issuer and subject) in
the metadata. None contains a storage key, file name or document content.

| Event | Entity | Records |
| --- | --- | --- |
| `storage.recovery_plan_created` | plan | creator, digest, expiry, counts |
| `storage.recovery_plan_approved` | plan | approver, digest, expiry |
| `storage.recovery_plan_revoked` | plan | revoker, reason, previous status |
| `storage.recovery_plan_claimed` / `storage.recovery_plan_resumed` | plan | executor; for a resume, the previous claimant |
| `storage.recovery_plan_completed` / `storage.recovery_plan_partially_completed` | plan | executor, entry states, run counts |
| `storage.recovery_plan_expired` | plan | when it was noticed |
| `storage.recovery_request_rejected` | plan, when the request named a valid one | the attempted action, the refusal, and the verified operator (or none, for a rejected credential) |
| `storage.write_recovered` / `storage.write_recovery_failed` / `storage.write_recovery_skipped` | journal entry | outcome, plan, digest, executor, and the generation or error code |

### 6.10 Why merging this does not enable production deletion

- **No production identity.** No trusted operator identity provider exists outside the tests, so no plan can be
  created, approved or executed.
- **A refusal no setting can lift.** Every step that reads or changes storage (create, claim, execute, preview)
  refuses in production, on Cloud Run, and against any storage endpoint other than a local emulator (a loopback
  `http://` address). No setting lifts this.
- **Preview only.** The command can only preview, and refuses production, Cloud Run, non-local databases and the real
  API.
- **No other entry point.** There is no API endpoint, no job, no workflow change and no new service account, secret or
  IAM binding.
- **Merging does change production's database.** Migration `0038` creates two empty tables, their triggers and
  functions when `deploy.yml` runs its migrate job. The change is additive and nothing in the application uses these
  tables; the previous code runs unchanged with them present.

### 6.11 Tests

All tests run against a disposable PostgreSQL 16 database, synthetic files, the simulated API and the tests' signed-token
identities. Uploads and workers are killed with SIGKILL.

- **`test/documents/object-store.test.ts`** (5 tests) covers the adapter.
- **`test/documents/approved-recovery.test.ts`** (22 tests) covers each of the AP-OPS-03 cases:
  1. valid plan creation;
  2. immutable plan contents;
  3. unauthorized approval, including self-approval and a creator bypass;
  4. trusted approval;
  5. forged identities: a tampered token, another key, issuer or audience, an expired token, a plain name, a
     caller-built object, or no provider;
  6. invalid digests;
  7. a modified plan;
  8. expiry, including during a run;
  9. revocation before execution;
  10. revocation during execution, both between entries and during a deletion;
  11. competing, forged and stale workers;
  12. a crash after claiming;
  13. a crash after deletion;
  14. a retry after failure, and untrusted or unavailable storage;
  15. generation changes before and during the deletion, and a deletion that did not take effect;
  16. lease renewal;
  17. referenced documents;
  18. a changed database, environment, endpoint, bucket or prefix;
  19. extra entries, both through the guard and by bypassing the triggers;
  20. a completed plan;
  21. the audit history;
  22. production still blocked.
- **The migration test** (1 test, in the same file) migrates a database through `0037`, journals writes, applies
  `0038`, checks that the writes are unchanged and the guards present, and runs a plan end to end on it.
  `test/db/migrations.test.ts` and `test/db/release-upgrade.test.ts` were updated for the two new tables and the
  39th migration.
- **Mutation proofs.** 25 safeguards were removed one at a time; each removal was caught by at least one failing test,
  and every mutation was restored, verified by checksum. The safeguards:
  - **identity:** the identity fallback, the role check, and separation of duties, both in the service and in the
    database;
  - **content:** the digest check, integrity at approval and at claim;
  - **expiry and claims:** expiry at approval and during execution, revocation during execution, the claim token and
    live-claim checks;
  - **rechecks:** environment binding, the lease, reference and generation rechecks, the generation precondition and
    post-delete verification;
  - **production and storage trust:** both production refusals and the storage witness;
  - **database triggers:** four guards (entries only in drafts, immutable entry and plan contents, no skipped
    approval).

### 6.12 Dependencies

None were added. The adapter calls the documented Cloud Storage JSON API with Node 22's `fetch`, and the identity
interface is plain TypeScript.

## 7. Production activation (a separate, approved milestone; not built)

### 7.1 Code changes for activation

1. **A production identity provider.** Proposal:
   - Each operator presents a Google-signed OIDC ID token for a recovery-specific audience
     (`gcloud auth print-identity-token --audiences=…`).
   - The token is verified against Google's published keys (issuer `https://accounts.google.com`, the audience, and
     its expiry).
   - The subject is the account's stable `sub` claim, not its email.
   - Roles come from a reviewed source: Google Groups membership, or a role map reviewed in the repository and
     deployed with the job. Never from the token holder.
   - The executor is the job's own service account, verified the same way through the metadata server.
2. **Lifting the emulator-only guard.** It should be lifted for the recovery job only: an explicit setting present
   only on that job, together with the production provider. The guard stays in force for the API service, which must
   never run recovery.
3. **The job's entry point.** It takes `create`, `approve <plan> <digest>`, `revoke <plan> <reason>` and
   `run <plan>`, each with the operator's credential, and logs JSON reports with no storage keys and no credentials.

### 7.2 IAM: separation-of-duties proposal

| Principal | Holds | Never holds |
| --- | --- | --- |
| Planners (operators, for example a `storage-recovery-planners` group) | `run.jobs.runWithOverrides` on the recovery job, and the planner role | bucket or database access |
| Approvers (Sagar Patel, or a `storage-recovery-approvers` group) | `run.jobs.runWithOverrides` on the job, and the approver role; cannot approve their own plans (enforced in code and in the database) | bucket or database access |
| Job service account `academiapath-recovery` (the executor) | `storage.objects.get` and `storage.objects.delete` on the documents bucket only (a custom role); `roles/cloudsql.client`; access to its own database secret | listing, object creation, any other bucket, project-wide roles |
| API runtime account `academiapath-runtime` | — | the project-wide `roles/storage.objectAdmin` it holds today must be removed (an open item) |

Nobody receives a service-account key. Cloud Audit Logs record who started each job execution, and `audit_log`
records the verified operator of each lifecycle step.

### 7.3 Database permissions for the job's dedicated login

| Table | Privileges |
| --- | --- |
| `document_storage_intents` | SELECT, UPDATE, DELETE (UPDATE also covers `FOR UPDATE` locks) |
| `course_documents` | SELECT |
| `storage_recovery_plans` | SELECT, INSERT, UPDATE |
| `storage_recovery_plan_entries` | SELECT, INSERT, UPDATE |
| `audit_log` | INSERT |

The triggers in §6.3 still constrain what UPDATE can do. The login's connection URL lives in its own Secret Manager
secret, readable only by the job's service account. Creating the login is a production database change that needs
Sagar's authorization; it is not part of the regular migrations.

### 7.4 Safe Cloud Run job execution model (proposal; do not create without approval)

- **One job**, `academiapath-storage-recover`, in `us-central1`, configured as follows:
  - **Image:** the release's `migrate` image.
  - **Identity:** the `academiapath-recovery` service account.
  - **Cloud SQL:** the `academiapath-db` connection.
  - **Secrets:** only the recovery database secret.
  - **Bucket:** no volume mount; the job uses the API.
  - **Ingress:** none.
  - **Sizing:** `--tasks=1 --parallelism=1 --max-retries=0 --task-timeout=10m`, 1 vCPU and 512 MiB.
- **Each lifecycle step is a separate execution** with overridden arguments: create, review, approve, run, revoke. The
  durable records carry state between executions, so no file or disk is needed.
- **Approvals happen outside the run.** A run execution only claims an already-approved plan; an approval is never
  part of a run.
- **Retries are deliberate.** A failed or interrupted run is resumed by a new execution after its claim lapses. Retrying
  is a human decision, which is why `max-retries` is 0.
- **Credentials.** Operators' credentials are passed per execution and are short-lived and audience-bound. The
  activation review must decide how to keep them out of the execution's stored configuration (for example by reading
  the token on standard input from a wrapper script).

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
| Plan and approval tables (this milestone) | none beyond negligible storage in the existing Cloud SQL instance: two small tables, created empty. |
| Cloud Run job | billed only while it runs, with a 1-minute minimum per instance ([pricing](https://cloud.google.com/run/pricing)). Each lifecycle step is one short execution (create, approve, run, and possibly revoke or resume), each a fraction of a cent and likely within the free tier. |
| Cloud Storage operations | each plan and each run reads metadata once per entry, plus the witness reads. These are Class B operations ($0.0004 per 1,000 for Standard storage). Deletes are free ([pricing](https://cloud.google.com/storage/pricing)). |
| Soft-deleted or noncurrent bytes | deleted orphans stay billed for the retention period. Enabling soft delete on the bucket, if it is off, applies to **every** deleted object, not only recovery's. |
| Secret Manager | one new secret (the restricted database URL): an active-version charge per month. |
| Identity | none expected: Google ID tokens and group membership checks carry no charge at this scale. |
| Logging | within the free allotment. |
| Cloud Scheduler | none: runs are manual. |

**Claudio's approval** is needed for:

- the job;
- the service account and its bindings;
- the secret;
- any change to the bucket's soft-delete or versioning settings.

**Sagar's authorization** is needed for:

- merging, which deploys and runs migration `0038`;
- the activation milestone;
- the database login;
- every production approval.

## 9. Deployment and rollback (when approved)

**Deployment:**

1. **This change.** Merging deploys migration `0038`: two empty tables, with their triggers and functions. Nothing uses
   them in production, and recovery stays impossible (§6.10).
2. **Read-only checks** by an authorized operator:
   - the bucket settings (§7.5);
   - the count of expired journal entries.
3. **The activation milestone** (§7.1), reviewed by Sagar.
4. **Create the infrastructure** (Claudio and Sagar): the service account and its bucket-scoped role, the database
   login and its secret, and the job (§7.2–§7.4).
5. **First production use:**
   1. A planner creates a plan.
   2. Sagar reviews it and approves it, quoting its digest.
   3. An executor runs it.
   4. Confirm the per-entry outcomes and the audit events.

**Rollback:**

- **To stop recovery:** revoke any open plan; to stop entirely, remove the operators' `run.jobs.run*` permissions or
  delete the job. Either is immediate.
- **To undo a mistaken deletion:** possible **only** if §7.5 showed soft delete or versioning. Restore the object
  generation named in the `storage.write_recovered` event.
- **To undo the application:** an older release runs unchanged with the new tables present. The tables and triggers
  can stay; dropping them would need a new, reviewed migration, and plan records are an audit trail.

## 10. Remaining blockers before activation

- **No production identity provider.** It must verify Google-issued credentials and take roles from a reviewed source
  (§7.1).
- **Credential handling.** The activation review must decide how operators' credentials reach a job execution without
  being stored in its configuration (§7.4).
- **The writer protocol.** A transaction is still held across each generation-matched deletion and its verification
  (bounded; §6.6). Removing it would need writers to honour a durable recovery claim.
- **Unverified bucket settings.** Soft delete and versioning are unknown (§7.5); until checked, every deletion must be
  treated as permanent.
- **Infrastructure and approvals.** The job, service account, database login and secret are not created; they need
  Claudio's and Sagar's approval.
- **Production permissions.** The runtime account's project-wide `objectAdmin` remains an exposure until it is
  removed.
- **Other residual risks:**
  - a writer stalled for more than 30 minutes that revives after recovery can leave an untraceable file (rare; never
    data loss);
  - files written before migrations `0036` and `0037` are not journaled;
  - the simulator is not Google's service, so the adapter is unproven against the real API until activation.

**Ready for production activation: NO.**
