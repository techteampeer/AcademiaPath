# ClamAV in production: feasibility and GCP proposal (AP-SEC-04)

**For:** Claudio Obregón (cost approval) and Sagar Patel (technical approval). **Status:** proposal only. Nothing was
created, deployed or enabled. Production malware scanning remains **off**: `deploy.yml` sets no scanner variable, so
every new document is still recorded `not_scanned`.

**How to read the numbers:**

- **Measured:** values marked *(measured)* come from a real ClamAV 1.5.4 daemon, run locally against the official
  signature database on 24 Nov 2026. That database is `main` v63 plus `daily` 28191, taken from the official
  `clamav/clamav:stable` image built on 23 Nov 2026. Scans went through AcademiaPath's own adapter. The machine was a
  development sandbox (Intel Xeon @ 2.30 GHz), with clamd pinned to 1 or 2 CPUs.
- **Estimated:** values marked *(estimate)* are not Cloud Run measurements. Cloud Run timings must be confirmed in
  staging (§6).

## 1. Recommended architecture

**A ClamAV sidecar container inside the existing `academiapath-api` Cloud Run service.**

- The ClamAV image contains its own signature database (fixed when the image is built).
- A scheduled job refreshes that image daily.
- The API calls clamd at `127.0.0.1:3310`. No new service, adapter or network path is needed.

```
academiapath-api instance (Cloud Run, gen2)
┌───────────────────────────────┐   127.0.0.1:3310 (inside the instance only)   ┌──────────────────────────────┐
│ api (ingress container, :8080)│ ─────────────────────────────────────────────▶ │ clamav sidecar (clamd)       │
│ upload → scan → extract → store│                                               │ signatures baked into image  │
└───────────────────────────────┘                                               └──────────────────────────────┘
   starts only after the sidecar's startup probe passes (container dependency)
```

**Options compared:**

| | **A. Sidecar (recommended)** | B. Dedicated internal scanning service | C. Scan after storing (Google's Cloud Storage reference design) |
| --- | --- | --- | --- |
| How | clamd beside the API in each instance | its own Cloud Run service with an HTTP wrapper around clamd, `internal` ingress and IAM-authenticated calls | an Eventarc trigger scans each new object and moves it to a clean or quarantine bucket ([Google architecture](https://docs.cloud.google.com/architecture/automate-malware-scanning-for-documents-uploaded-to-cloud-storage)) |
| Code changes | none to the adapter; timeouts, signature freshness check, deploy (§7) | a new HTTP adapter, an HTTP-to-clamd service and service-to-service authentication | a redesign: files would be stored and reachable before they are scanned, which contradicts the current scan-before-store guarantee |
| Memory, CPU | +3 GiB and +1 vCPU per API instance, only while instances exist | about 3 GiB and 1–2 vCPU for the scanner, plus its own minimum instance to stay warm | the same scanner, plus buckets and a trigger |
| Cold start | the instance becomes ready after clamd loads, about 10–25 s *(estimate)* | uploads wait for the scanner's own cold start, or pay for an always-on instance | asynchronous |
| Network exposure | none: loopback inside one instance. Cloud Run routes requests only to the ingress container's port | an internal endpoint, IAM and VPC configuration | event plumbing between services |
| Scaling | one scanner per API instance (at most 3), at most 2 scans each | independent, but an extra hop for up to 10 MB per upload | independent |
| Recurring cost | the lowest: you pay only for API active time (§3) | higher: an always-on scanner instance is needed for acceptable latency | higher, and a larger security change |

**Why A:**

- It is the only option that keeps the existing, tested synchronous guarantee: nothing is stored before a verified
  scan.
- It adds no network surface. The clamd protocol has no authentication, so the API's configuration already refuses
  anything but loopback or a Unix socket.
- It needs no new adapter.
- Its cost scales to zero with the API.

B becomes worthwhile only if upload volume makes per-instance scanners wasteful. A paid external scanning API was
rejected because student documents would leave the project.

## 2. Required Cloud Run resource changes

**Current settings** (from `.github/workflows/deploy.yml`; the live service was not inspected):

| `academiapath-api` setting | Value |
| --- | --- |
| Execution environment | gen2 |
| Memory | 1 GiB |
| CPU | not set, so the default 1 vCPU |
| Instances | min 0, max 3 |
| Billing | request-based (no `--no-cpu-throttling`) |
| Request timeout | default (300 s) |
| Volumes | Cloud Storage FUSE documents mount |
| Containers | one |

Settings that `deploy.yml` does not pass (concurrency, timeout, startup CPU boost) keep whatever earlier deploys set.
Confirm them with `gcloud run services describe academiapath-api --region us-central1`, which is read-only, before the
change.

**Proposed instance (2 vCPU, 4 GiB in total):**

| Container | CPU | Memory | Why |
| --- | --- | --- | --- |
| `api` (ingress, unchanged image) | 1 | 1 GiB | as today |
| `clamav` (sidecar) | 1 | 3 GiB | about 1.0 GiB of signatures loaded *(measured: 969–1,001 MiB)*, up to 1.13 GiB while scanning *(measured)*, plus a size-limited in-memory volume of up to 1 GiB for clamd's temporary files |

Other settings:

- **Startup order:** the `api` container depends on `clamav`. `clamav` has a TCP startup probe on 3310; clamd opens
  the port only after loading its signatures *(measured)*.
- **Billing:** request-based, as today. The sidecar needs CPU only during scans (inside requests) and during startup;
  per Google's docs, a startup probe keeps the sidecar from being CPU-throttled while it starts.
- **Instances:** min 0, max 3, as today. A minimum instance is Claudio's decision (§9).
- **Startup CPU boost:** keep it on. Sidecars receive it too.
- **Timeouts:** the request timeout stays at 300 s. The upload path gets explicit, aligned timeouts (§7, change 1).

These sizes satisfy Cloud Run's CPU-to-memory limits: up to 4 GiB is allowed at 1 vCPU or more per instance.

**Why the memory is needed:**

- Cloud Run's container filesystem is in memory, and anything written to it counts against the instance limit
  ([container contract](https://docs.cloud.google.com/run/docs/container-contract)).
- Exceeding the limit terminates the instance, and its in-flight requests fail.
- clamd writes decompressed parts of Office files and PDFs to its temporary directory. A size-limited in-memory volume
  for that directory turns an oversized extraction into a scanner error (refused in strict mode) instead of a crashed
  instance.

**Settings `clamd.conf` must have in the sidecar image.** The official image's own `clamd.conf` listens on TCP 3310 on
**all interfaces** and leaves `AlertExceedsMax` off *(measured: read from the image)*, so both are overridden:

```text
TCPSocket 3310
TCPAddr 127.0.0.1            # loopback only (the API refuses any other address)
StreamMaxLength 25M          # >= MALWARE_SCAN_MAX_MB (25) >= DOCUMENT_MAX_UPLOAD_MB (10)
MaxFileSize 100M             # ClamAV default; per extracted part (Office XML, PDF streams decompress)
MaxScanSize 400M             # ClamAV default; total decompressed data per file
MaxScanTime 50000            # off by default; stops pathological files before the API's 60 s deadline
AlertExceedsMax yes          # off by default: a file that hits any limit would otherwise answer "OK"
MaxThreads 4                 # >= MALWARE_SCAN_CONCURRENCY (2)
ConcurrentDatabaseReload no  # signatures never change inside a running sidecar; avoids a 2x memory peak
TemporaryDirectory /scratch  # the size-limited in-memory volume
```

*(measured)* ClamAV 1.5.4 defaults, from `clamconf`:

| Setting | Default |
| --- | --- |
| `AlertExceedsMax` | off |
| `MaxScanTime` | off |
| `StreamMaxLength` | 100 MiB |
| `MaxFileSize` | 100 MiB |
| `MaxScanSize` | 400 MiB |
| `ConcurrentDatabaseReload` | yes |

`MaxScanSize` and `MaxFileSize` are **not** lowered to the upload size. A 17 MB text PDF that decompressed to more
than 100 MB came back `limits_exceeded` with `MaxScanSize 100M` *(measured)*, so lower limits would refuse legitimate
compressed documents in strict mode. This corrects the earlier recommendation in `malware-scanning.md`.

## 3. Cost estimate and assumptions

**Prices:** Cloud Run, us-central1, request-based billing, Tier 1, read from the
[pricing page](https://cloud.google.com/run/pricing) on 24 Nov 2026:

| Item | Price |
| --- | --- |
| Active vCPU | $0.000024 per vCPU-second |
| Active memory | $0.0000025 per GiB-second |
| Idle minimum instance | $0.0000025 per vCPU-second and per GiB-second |
| Requests | $0.40 per million |
| Free tier | 180,000 vCPU-seconds, 360,000 GiB-seconds and 2 million requests per month, per billing account |

The free tier is shared with the web service and the ITIL platform in the same billing account, so **all figures below
exclude it**.

**What that means per instance-hour:**

| Instance | Active | Idle minimum instance |
| --- | --- | --- |
| Today: 1 vCPU, 1 GiB | **$0.0954** per hour | — |
| Proposed: 2 vCPU, 4 GiB | **$0.2088** per hour | **$0.054** per hour, about $39 per month if never busy |

**Assumptions** *(estimates: no billing or traffic data was accessed)*:

| | Low (pilot) | Moderate (institutional term) | Increased uploads |
| --- | --- | --- | --- |
| API active instance-hours per month | 40 | 300 | 900 |
| Document uploads per month | 300 | 3,000 | 20,000 |
| Average scan time per upload | 2 s | 3 s | 3 s |
| Cold starts per month (min 0) | 120 | 60 | 30 |
| Extra time per cold start (clamd load) | 15 s | 15 s | 15 s |

**Estimated monthly Cloud Run cost for `academiapath-api`, before the free tier and discounts:**

| Scenario | Today (no scanner) | Proposed, min 0 | Difference | Proposed, min 1 | Difference |
| --- | --- | --- | --- | --- | --- |
| Low | $3.82 | $8.49 | **+$4.68** | $45.65 | **+$41.83** |
| Moderate | $28.62 | $63.21 | **+$34.59** | $86.38 | **+$57.76** |
| Increased | $85.86 | $191.43 | **+$105.57** | $191.40 | **+$105.54** (already always busy) |

How these were computed:
- **Proposed, min 0:** the active hours at the proposed rate, plus scan time and cold-start time.
- **Min 1:** adds the hours when no instance is busy, at the idle minimum-instance rate.

**Other recurring costs:**

| Item | Estimate |
| --- | --- |
| Artifact Registry | about 0.2 GB per ClamAV image (`clamav/clamav` 1.5: 196 MB *(measured from Docker Hub)*). Keeping 7 daily images comes to about 1 GB, at $0.10 per GB-month beyond the 0.5 GB free tier: **under $0.15 per month**. Image pulls by Cloud Run in the same region are free ([pricing](https://cloud.google.com/artifact-registry/pricing)). |
| Network | none. Signatures arrive inside the image, and data transfer into Google Cloud is free. Cloud Run never contacts ClamAV's servers. |
| Daily image refresh | GitHub Actions minutes, about 3–5 per day (not a GCP charge). |
| Logging | negligible: one scan log line per upload. |
| Staging validation (§6) | a temporary service for a few hours: **under $5** *(estimate)*, then deleted. |
| Cheaper options | for steady heavy use, instance-based billing ($0.000018 per vCPU-second, $0.000002 per GiB-second) or committed use discounts lower the "Increased" row by about 20–25%. |

## 4. Required IAM and network controls

- **No new service account.** The sidecar runs under the API's existing identity, `academiapath-runtime`, and needs no
  Google API.
  - The sidecar mounts neither the documents bucket nor any secret: the deploy gives it no volumes except its scratch
    volume.
  - The open item to replace that account's project-wide `objectAdmin` with bucket-scoped access is unaffected.
- **No new ingress.**
  - Cloud Run sends requests only to the ingress container's port.
  - clamd binds to `127.0.0.1`, so only containers of the same instance can reach it.
  - The API's configuration refuses any non-loopback `CLAMD_ADDRESS`.
- **No outbound connection from production to ClamAV.** freshclam is disabled in the sidecar
  (`CLAMAV_NO_FRESHCLAMD=true`). This matters for two reasons:
  - ClamAV rate-limits signature downloads per IP address, and warns that shared cloud IP ranges are likely to be
    rate limited ([FreshClam FAQ](https://docs.clamav.net/faq/faq-freshclam.html),
    [private mirror](https://docs.clamav.net/appendix/CvdPrivateMirror.html)).
  - With request-based billing, background updates would be CPU-throttled anyway
    ([billing settings](https://docs.cloud.google.com/run/docs/configuring/billing-settings)).
- **Image provenance.**
  - The refresh workflow pulls the official `clamav/clamav:1.5` image by tag.
  - It records the resolved digest, adds the reviewed `clamd.conf`, and pushes the result to the existing Artifact
    Registry repository `academiapath`.
  - Production deploys only images from that registry, never Docker Hub directly. ClamAV is removing unsupported
    images from Docker Hub ([ClamAV blog](https://blog.clamav.net/)).
  - The deployer account already has the Artifact Registry writer role, so no new permission is needed.

## 5. Signature update procedure

The signatures are baked into the image; there are no updates inside the running service. ClamAV's official images
ship the database current at build time ([ClamAV in Docker](https://docs.clamav.net/manual/Installing/Docker.html)).
The `1.5` tags on Docker Hub were rebuilt on 23 Nov 2026 *(observed)*.

1. **Daily refresh.** A scheduled GitHub Actions workflow (a new, reviewed file):
   1. pulls `clamav/clamav:1.5`;
   2. checks the database inside it with `sigtool --info`: the signatures verify, and the daily version is at most
      24 h old;
   3. builds the sidecar image with the reviewed `clamd.conf`;
   4. starts it once and requires `PONG` from clamd and detection of the EICAR test file;
   5. pushes it to Artifact Registry;
   6. updates only the sidecar image of `academiapath-api`, creating a new revision;
   7. checks `/api/v1/health`.

   Any failure leaves the previous revision serving.
2. **Freshness cannot silently stop.** This needs a code change (§7, change 2):
   - The API reads clamd's `VERSION`, which carries the date of the daily signatures, at startup and every hour.
   - It logs an error after 48 hours, which a log-based Cloud Monitoring alert emails to Sagar.
   - In strict mode it refuses uploads (`503`, bilingual message) after a hard limit, proposed at 7 days, rather than
     claiming protection with stale signatures.
   - GitHub also reports failed workflow runs to the repository admins.
3. **Version upgrades** (for example 1.5 to 1.6) are reviewed pull requests, not automatic. ClamAV 1.5 is a non-LTS
   line; 1.4 is the LTS line, supported until August 2027
   ([EOL policy](https://docs.clamav.net/faq/faq-eol.html)). Moving to the next LTS is planned before 1.5's end of life.

**Measured on the official database:**

- **Size:** `main.cvd` 89.1 MB, `daily.cvd` 23.4 MB and `bytecode.cvd` 0.3 MB.
- **Signatures:** 3,642,871 in total (3,287,027 in `main` and 355,844 in `daily`). `malware-scanning.md` said "about
  300 MB"; that was not measured and is wrong.
- **Startup:** loading takes 8.2–9.9 s and 8–9.3 CPU-seconds, the same with 1, 2 or 4 CPUs.
- **Concurrent reload, in contrast:** 8.1–8.7 s and a 2.02–2.06 GiB peak, with scanning continuing.
- **Non-concurrent reload on 1 CPU:** scanning blocked for 37 s.

That is why the sidecar never reloads and the image is refreshed instead.

## 6. Staging test plan

The staging environment would be a temporary `academiapath-api-staging` service, with the same images and settings
and synthetic data. It needs Claudio's approval (§9). Nothing below has been run in the cloud.

| # | Test | Pass criteria |
| --- | --- | --- |
| 1 | Official signatures loaded | clamd `VERSION` shows a daily database at most 24 h old; the startup log reports at least 3.5 M signatures; the API logs `clamd is reachable` |
| 2 | Clean documents: 10 PDF, 10 DOCX and 10 PPTX of real-world shape, including 10 MB files | 100% accepted and recorded `clean`. Scan time p95 ≤ 15 s; whole upload p95 ≤ 30 s (local reference *(measured, 2 CPUs)*: 2 MB PDF 0.6 s, 10 MB PDF 2.8–5.8 s, 10 MB DOCX 6.4 s, 10 MB PPTX 7.1 s) |
| 3 | EICAR test file, alone and inside a ZIP | `422 MALWARE_DETECTED` in both modes; a `document.upload_rejected` audit; no document, file or journal entry. EICAR only matches the exact test file: one with extra bytes appended is clean *(measured)* |
| 4 | Oversized and over-limit files | an 11 MB upload gives `413` before scanning; a file exceeding `MaxScanSize` or `MaxScanTime` gives `503 MALWARE_SCAN_UNAVAILABLE` in strict mode and `not_scanned` (`clamd:error`) in compatibility mode |
| 5 | Timeouts and restarts | with `MALWARE_SCAN_TIMEOUT_SECONDS=5` and a slow file: strict `503`, compatibility `not_scanned`. No `5xx` from the web proxy and no duplicate documents. After a new revision and after scale-to-zero, the first upload succeeds |
| 6 | Concurrency | 10 simultaneous 10 MB uploads: all `clean`, none over 60 s, no `5xx` |
| 7 | Memory | sidecar memory at most 75% of its limit during test 6; no instance terminations (Cloud Monitoring) |
| 8 | Cold starts | 10 scale-from-zero starts: first-request success 10/10; instance startup p95 ≤ 30 s |
| 9 | Language | in the UI, `MALWARE_DETECTED` and `MALWARE_SCAN_UNAVAILABLE` read correctly in Spanish and English (manual QA: Havisha for the Student and Design Team roles, Atharva for the Instructor roles; observed results recorded) |
| 10 | Archive import and journaling | `ARCHIVE_IMPORT_ENABLED=true` still stops a production-mode API from starting. Refused uploads leave no file or journal entry; accepted uploads settle their journal entry; a storage recovery dry run shows nothing abandoned |
| 11 | Signature refresh | one manual run of the refresh workflow creates a revision with a newer daily version. With the staleness threshold temporarily set to 1 hour, the error log and alert fire |

All tests must pass, and the measured cold-start and latency figures replace the estimates in §1–§3.

## 7. Code and deployment changes needed before strict scanning

None of these is in this document's pull request.

1. **Aligned timeouts.** Today, every upload passes through the web app's Next.js proxy, whose default timeout is
   **30 s** (`proxyTimeout || 30000` in the installed Next.js 16.4.5). The API's scan deadline is also 30 s, and
   extraction adds up to 20 s. A slow upload can therefore be cut off at the proxy while the API still stores the
   document, which can lead to duplicate uploads. Set:
   - clamd `MaxScanTime` 50 s;
   - `MALWARE_SCAN_TIMEOUT_SECONDS=60`;
   - `experimental.proxyTimeout` of 120 s in `apps/web/next.config.ts` (a web change, so tech-lead review is needed).
2. **Signature freshness guard (API).**
   - Parse the daily version date from clamd's `VERSION`, at startup and every hour.
   - Log an error after 48 h.
   - In strict mode, refuse uploads after 7 days.
   - Show the scanner's state to administrators.
   - Add tests.
3. **Sidecar image definition:** `infra/clamav/Dockerfile`, based on the official 1.5 image recorded by digest, plus
   `clamd.conf` (§2).
4. **`deploy.yml`:** a multi-container deployment.
   - Container dependencies and the sidecar's startup probe are set through a service YAML and
     `gcloud run services replace`, the documented path
     ([containers](https://docs.cloud.google.com/run/docs/configuring/services/containers),
     [health checks](https://docs.cloud.google.com/run/docs/configuring/healthchecks)).
   - Resources as in §2.
   - Environment: `MALWARE_SCANNER=clamd`, `CLAMD_ADDRESS=127.0.0.1:3310`, `MALWARE_SCAN_TIMEOUT_SECONDS=60`, and
     `MALWARE_SCAN_ENFORCEMENT=compatibility` first, `strict` later.
   - Keep `infra/cloud-run.env.example` in sync.
5. **The daily refresh workflow** (§5).
6. **Decide on the demo seed job.** It stores synthetic documents through the API's own code without a scanner, so they
   are recorded `not_scanned`. That can stay as it is (synthetic data, run by hand), or the job can get its own
   sidecar.

**Security requirements: what the code already does** (verified by reading the code on `main` at `0b94b6d`, by its
tests, and by the real-clamd measurements above):

| # | Requirement | Status |
| --- | --- | --- |
| 1 | Only a real, successful scan marks a file clean | **Met.** Only the exact answer `stream: OK` after the whole stream is a clean verdict (`parseClamdReply`), and `decideScan` alone sets the status. |
| 2 | Strict mode rejects infected files and scanner failures | **Met.** Infected files are refused in both modes; strict refuses `unavailable`, `timeout`, `error` and unknown results. |
| 3 | No upload can bypass scanning | **Met.** The only two document write paths, the upload route and archive import, scan before storing anything. The demo seed job uses the upload route without a scanner (change 6). |
| 4 | Unauthorized clients cannot reach clamd | **Met in code** (loopback or Unix socket only); **needs** `TCPAddr 127.0.0.1` in the sidecar (§2). |
| 5 | Size and time limits cover the largest document | **Partly.** The configuration requires `MALWARE_SCAN_MAX_MB` ≥ the upload limit, and oversized files are refused. **Timeouts must be aligned** (change 1). |
| 6 | `AlertExceedsMax` is configured | **Needs the sidecar `clamd.conf`.** It is off by default and in the official image. The API already treats limit alerts as "not verified". |
| 7 | Signature updates cannot silently stop | **Not yet:** needs changes 2 and 5. |
| 8 | Unavailable scanners are handled safely | **Met.** Strict mode answers `503 MALWARE_SCAN_UNAVAILABLE`; compatibility records `not_scanned` with the reason. The startup check is logged and never blocks. |
| 9 | Existing `not_scanned` documents are never treated as clean | **Met.** They are never relabeled, and staff see a "Not scanned" badge. Rescanning them needs a tool that does not exist yet (§10). |
| 10 | Production ZIP imports stay disabled | **Met, independently.** The API refuses to start in production with `ARCHIVE_IMPORT_ENABLED=true`, whatever the scanning settings. |

## 8. Production activation checklist, rollback and failure handling

**Activation**, each step a separate, approved change:

1. Claudio approves the costs and resources (§9), and Sagar approves the code changes (§7).
2. Merge changes 1–5, with scanning still off.
3. Run staging (§6) and record the results; then delete the staging service.
4. Production deploy with `MALWARE_SCANNER=clamd` and `compatibility` enforcement. Watch for a week:
   - `Malware scanning: clamd is reachable`;
   - scan outcomes and durations in the logs;
   - `document.upload_rejected` audits;
   - instance memory;
   - the freshness alert.
5. Switch to `strict` when there are no unexpected `clamd:error` or `clamd:timeout` outcomes.
6. Document the `not_scanned` backlog of earlier uploads (§10).

**Rollback**, in seconds to minutes, with no data migration:

- Route traffic back to the previous revision (`gcloud run services update-traffic … --to-revisions=PREVIOUS=100`).
- Or set `MALWARE_SCAN_ENFORCEMENT=compatibility`.
- Or set `MALWARE_SCANNER=none`.

Documents keep their recorded status, because nothing is relabeled.

**Failure handling:**

| If | Strict mode | Compatibility mode |
| --- | --- | --- |
| the sidecar is down | uploads are refused with a bilingual "try again later" (`503`) | uploads are accepted as `not_scanned` |
| signatures are too old | uploads are refused (change 2) | an alert fires |
| memory runs out | the instance is replaced by Cloud Run, its in-flight requests fail and the user can retry; the size-limited scratch volume prevents the most likely cause | same |

Rolling back the scanner never deletes or alters documents.

## 9. Decisions requiring Claudio's approval

1. **Larger API instances:** 2 vCPU and 4 GiB (today 1 vCPU and 1 GiB), up to the existing 3 instances. Estimated
   **+$5 to +$106 per month** (§3).
2. **Minimum instances:** 0 or 1.
   - 0: cheaper, but the first upload after an idle period waits for clamd to load, about 10–25 s.
   - 1: no cold starts, about **+$37 per month** more at low traffic.
3. **A temporary staging service** for §6: estimated under $5, deleted afterwards.
4. **Artifact Registry storage** for the daily sidecar image, keeping 7: about $0.15 per month.
5. **Optionally:** a budget alert on the `app=academiapath` label, and a later switch to instance-based billing or
   committed use discounts if traffic becomes steady.

Sagar's approval is needed for:

- the code changes in §7, including the web proxy timeout;
- the staleness thresholds;
- when to switch to strict mode;
- the seed-job decision;
- every production deployment.

## 10. Remaining unknowns

- **Cloud Run timings.** Real startup time and scan latency on Cloud Run vCPUs. The local measurements are on a
  different processor, so staging tests 2 and 8 settle this.
- **Real documents.** Scan times depend heavily on document structure. A synthetic, many-object 9.7 MB text PDF took
  50 s *(measured)*, while real slide-deck-like files took under 7.1 s. The institution's own document mix must be
  sampled in staging.
- **Traffic.** No billing or traffic data was used. The three scenarios are assumptions, so replace them with Cloud
  Monitoring data.
- **Sidecar failure.** What Cloud Run does to the instance when a sidecar process exits is not documented in the pages
  reviewed. Staging test 5 observes it.
- **Live service settings.** Settings not passed by `deploy.yml` were not read from GCP (§2).
- **The free tier** is shared across the billing account, so the real charge may be lower than §3.
- **Existing documents.** Rescanning documents uploaded before activation needs a separate tool and its own approval.
  Until then they stay `not_scanned`, visible to staff.
- **ClamAV support dates.** No end-of-life date has been announced for ClamAV 1.5. Plan to follow the LTS line.

**Ready to activate scanning: NO.** It needs the changes in §7, the staging results in §6, and the approvals in §9.

## Sources

**Google Cloud:**
- [Cloud Run pricing](https://cloud.google.com/run/pricing) (read 24 Nov 2026)
- [Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing)
- [Configure containers (sidecars, dependencies)](https://docs.cloud.google.com/run/docs/configuring/services/containers)
- [Health checks and startup probes](https://docs.cloud.google.com/run/docs/configuring/healthchecks)
- [Billing settings](https://docs.cloud.google.com/run/docs/configuring/billing-settings)
- [Container runtime contract](https://docs.cloud.google.com/run/docs/container-contract)
- [In-memory volumes](https://docs.cloud.google.com/run/docs/configuring/services/in-memory-volume-mounts)
- [CPU limits and startup CPU boost](https://docs.cloud.google.com/run/docs/configuring/services/cpu)
- [Memory limits](https://docs.cloud.google.com/run/docs/configuring/services/memory-limits)
- [Malware scanning reference architecture](https://docs.cloud.google.com/architecture/automate-malware-scanning-for-documents-uploaded-to-cloud-storage)

**ClamAV:**
- [ClamAV in Docker](https://docs.clamav.net/manual/Installing/Docker.html)
- [FreshClam FAQ](https://docs.clamav.net/faq/faq-freshclam.html)
- [Private database mirror](https://docs.clamav.net/appendix/CvdPrivateMirror.html)
- [End-of-life policy](https://docs.clamav.net/faq/faq-eol.html)
- [ClamAV blog](https://blog.clamav.net/)
- [clamd.conf(5)](https://manpages.debian.org/unstable/clamav-daemon/clamd.conf.5.en.html)

**Measurements:** the local clamd measurement scripts are not committed. They used the repository's
`apps/api/src/documents/clamd.ts` and `test/helpers/documents.ts`.
