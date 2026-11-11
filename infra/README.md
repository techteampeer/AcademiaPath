# Deploying AcademiaPath to Google Cloud

The demo runs on Cloud Run in project `elearning-514315` (region `us-central1`). Every merge to `main` builds and deploys it through GitHub Actions.

| Service | URL |
| --- | --- |
| Web | https://academiapath-web-871079669510.us-central1.run.app |
| API health | https://academiapath-api-871079669510.us-central1.run.app/api/v1/health |

The same GCP project will also host the migrated ITIL eLearning platform. Everything that belongs to AcademiaPath uses the `academiapath` prefix and the label `app=academiapath`; ITIL uses `itil-`. Filter Billing reports by that label to see each platform's cost.

## What is deployed

| Resource | Name | Notes |
| --- | --- | --- |
| Cloud Run service (API) | `academiapath-api` | Fastify, Dockerfile target `api`, runs as `academiapath-runtime` |
| Cloud Run service (web) | `academiapath-web` | Next.js, Dockerfile target `web`, port 3000; proxies `/api/*` to the API |
| Cloud Run job | `academiapath-migrate` | Drizzle migrations, Dockerfile target `migrate`; runs before every API deploy |
| Cloud SQL | `academiapath-db` | PostgreSQL 16, `db-f1-micro`, database `academiapath`, user `academiapath_app`; billed while it exists |
| Secret Manager | `academiapath-db-url` | `DATABASE_URL` over the Cloud SQL socket |
| Cloud Storage | `elearning-514315-academiapath-files` | Private; mounted in the API at `/mnt/documents` for uploaded documents |
| Artifact Registry | `academiapath` | Docker images `api`, `migrate`, `web`, tagged with the commit SHA |
| Service account | `academiapath-runtime` | Used by the running services: Cloud SQL client, Vertex AI user, secret accessor, object admin on its bucket |
| Service account | `academiapath-deployer` | Used by GitHub Actions: Cloud Run admin, Artifact Registry writer, can act as `academiapath-runtime` |
| Cloud Run job (prepared, not created yet) | `academiapath-seed-demo` | One-off demo seed, run by hand only; reuses the release's `migrate` image and `academiapath-runtime`. See "Demo users and courses" below |
| Secret Manager (prepared, not created yet) | `academiapath-demo-credentials` | The five demo role accounts' passwords, created by `infra/demo-credentials.sh`; readable only by `academiapath-runtime` and the people granted access |

Environment variables for each service, and where each value comes from, are listed in [`cloud-run.env.example`](cloud-run.env.example).

## How a deployment works

`.github/workflows/deploy.yml` runs on every push to `main`, or manually from **Actions → Deploy to Cloud Run (demo) → Run workflow**.

1. It authenticates with the `GCP_SA_KEY` repository secret, the JSON key of `academiapath-deployer`.
2. It builds the `api`, `migrate` and `web` images and pushes them to Artifact Registry. `API_ORIGIN` is passed at build time because Next.js fixes its rewrites when it builds.
3. It runs the `academiapath-migrate` job and waits for it. A failed migration stops the deployment before the API changes.
4. It deploys `academiapath-api`, then `academiapath-web`.
5. It smoke-tests `/api/v1/health` and the web `/login` page.

A full run takes about 5 minutes. The first one succeeded on November 10, 2026 (commit `98996d1`).

## One-time setup (already done)

Keep these steps for a new environment, such as a university's own project.

1. Enable the APIs: Cloud Run, Cloud SQL Admin, Cloud Storage, Vertex AI, Secret Manager, Artifact Registry and IAM.
2. Create the Artifact Registry repository `academiapath` and the two service accounts with the roles in the table above.
3. In Cloud Shell, run `bash infra/setup-demo.sh`. It creates Cloud SQL, the database and user, the `academiapath-db-url` secret and the documents bucket. It is safe to re-run, and it never prints the database password.
4. Create a JSON key for `academiapath-deployer` and save its full content as the GitHub repository secret `GCP_SA_KEY`. Delete the local key file afterwards.

## Firebase Authentication (Identity Platform)

Firebase is attached to the same project (`elearning-514315`), and Authentication is upgraded to **Identity Platform**. The application does not use it yet: sign-in still runs on the API's own password and session tables until the integration described in the functional spec (Authentication section) is built.

### Configured in the Firebase console

| Setting | Value |
| --- | --- |
| Sign-in providers | Email/Password and Google enabled. Microsoft and the university's SAML or OIDC SSO come later. |
| Public-facing name | `AcademiaPath`. Shown on the Google sign-in screen and used as `%APP_NAME%` in emails. |
| Support email | `claudio.obregon@peer-consulting.com`. Change it later in Project settings → General; the list only offers project members or Google Groups you manage. |
| User account linking | Link accounts that use the same email, so one person stays one user across providers. |
| Authorized domains | `localhost`, plus `academiapath-web-871079669510.us-central1.run.app` (check it is listed; Firebase sign-in fails on any domain that is not). |
| Email sender name | `AcademiaPath`, from `noreply@elearning-514315.firebaseapp.com` |

### Email templates and language

The platform is bilingual, and Firebase handles this with **one template per email type**. Firebase ships its own translated version of each template.

- **Template language (Spanish):** in Authentication → Templates, the template language is set to **Spanish**. That only sets the default language; it does not replace the English template.
- **Per-user language:** when the web app requests a verification or password-reset email, it must set the user's language first, with `auth.languageCode = 'es'` or `auth.languageCode = 'en'`, from the user's language preference in AcademiaPath. Firebase then sends that language's version.
- **No language set:** Firebase uses the default, Spanish.
- **Keep subject and body unmodified.** Firebase only translates its default text. A subject typed by hand is sent as-is to every user, whatever their language. The body of the email verification template cannot be edited at all, to prevent spam.
- **Full control:** for custom content or design, generate the action links in the API with the Firebase Admin SDK (`generateEmailVerificationLink`, `generatePasswordResetLink`) and send the emails through a transactional email service. SMTP settings in the console only change the sending server, not the text.

### Still to do for the integration

- Grant the API's runtime account the Firebase Auth admin role. It needs no key; the Admin SDK uses Application Default Credentials:
  ```bash
  gcloud projects add-iam-policy-binding elearning-514315 \
    --member=serviceAccount:academiapath-runtime@elearning-514315.iam.gserviceaccount.com \
    --role=roles/firebaseauth.admin
  ```
- Register the web app in Project settings → Your apps → Web (`academiapath-web`), and copy its config into the `NEXT_PUBLIC_FIREBASE_*` variables listed in `cloud-run.env.example`. These values are public by design, not secrets.
- Do not create keys for the `firebase-adminsdk-…` service account that Firebase created.

## Demo users and courses (seed job)

The demo database starts empty. The one-off Cloud Run job `academiapath-seed-demo` creates the synthetic accounts and the demo courses through the API's own code (authentication, authorization, review, grading and audit), the same dataset as `pnpm db:seed:demo` locally plus the AP-025 announcements and calendar. **No deployment and no start-up runs it.** Someone runs it on purpose, from **Actions → Seed demo data (manual)** ([`seed-demo.yml`](../.github/workflows/seed-demo.yml)) or with the `gcloud` commands below. Code: `apps/api/scripts/seed-cloud-demo.ts` and `apps/api/scripts/demo/cloud.ts`.

| Mode | What it does |
| --- | --- |
| `check` (default) | Read-only. Verifies the environment, that every migration is applied, that the database holds only synthetic demo data, that document storage is writable and every stored document is present, and that the credentials are valid. |
| `create` | Creates what is missing. An existing account keeps its password. Re-running creates nothing. Ends by signing each role account in once with its credential. |
| `reset-credentials` | Replaces the five role accounts' passwords with the latest secret version and ends their open sessions. Changes nothing else. |

### Safety rules

- **Approved environment only.** It runs only as the Cloud Run job `academiapath-seed-demo` in `elearning-514315`, with:
  - `NODE_ENV=production`;
  - the `academiapath` database on `academiapath-db`;
  - the documents bucket mounted at `/mnt/documents`; otherwise the uploaded demo documents would be lost with the container.

  It refuses to run inside a Cloud Run service. A `local` target exists for testing against a database on the developer's machine only.
- **Typed confirmations.**
  - `create` needs `DEMO_SEED_CONFIRM=academiapath-demo`.
  - `reset-credentials` also needs `DEMO_SEED_CONFIRM_RESET=reset-demo-credentials`.
  - The job definition defaults to `check`.
- **Stops before changing anything** if the database holds:
  - accounts outside the synthetic set;
  - demo accounts with another system role;
  - academic records that are not demo fixtures;
  - document rows whose file is missing.

  A credential reset checks the accounts only.
- **One run at a time:** a PostgreSQL advisory lock, and the job has no retries.
- **No secrets in output.** It prints no password, hash, session token or database URL. Every run and account change is audited:
  - `system.demo_seed` and `auth.seed_session`;
  - `user.created`, `user.password_set` and `user.password_reset`.

  The job's sessions are revoked when it ends.
- **Development seeds stay local.** `db:seed:dev` and `db:seed:demo` still refuse production, Cloud Run and Cloud SQL.

### Demo accounts

| Display name | Email | Role |
| --- | --- | --- |
| Demo Administrator | `admin@academiapath.example` | Administrator (system role) |
| Demo Reviewer | `reviewer@academiapath.example` | Design team in all four courses |
| Demo Instructor | `instructor@academiapath.example` | Instructor in all four courses (including the draft evening group) |
| Demo Teaching Assistant | `ta@academiapath.example` | Non-editing instructor in ITIL 4 Foundation and Project Management; student in Introduction to AI |
| Demo Student | `student@academiapath.example` | Student in all four courses (the draft course stays hidden until published) |

`learner.a@` and `learner.b@academiapath.example` are supporting learners. They have no password and cannot sign in; they only fill gradebooks.

### Credentials

- **Where they live.** Each role account gets its own random 24-character password in the Secret Manager secret `academiapath-demo-credentials`.
  - [`demo-credentials.sh`](demo-credentials.sh) creates the secret and prints nothing.
  - The job reads it as `academiapath-runtime`. GitHub never sees it.
- **Who may read it.** Grant access per person (Sagar decides who):
  ```bash
  gcloud secrets add-iam-policy-binding academiapath-demo-credentials --project=elearning-514315 \
    --member=user:EMAIL --role=roles/secretmanager.secretAccessor
  ```
- **How to retrieve them.** Into a file only you can read:
  ```bash
  (umask 077; gcloud secrets versions access latest --secret=academiapath-demo-credentials \
    --project=elearning-514315 > ~/academiapath-demo-credentials.json)
  ```
  Delete the file after the demo. Never paste the passwords into chat, e-mail, tickets or GitHub.
- **Rotation.** Run `demo-credentials.sh` again, which adds a version, then run the seed in mode `reset-credentials`. Do this after the demo.

### Release sequence (one coordinated rollout)

1. **Approvals (Sagar).** Approve:
   - the deployment;
   - the new secret;
   - the IAM bindings;
   - creating the seed job.
2. **Merge the preparation PR into `feat/ap-025-announcements-calendar`.** This deploys nothing: only pushes to `main` deploy.
3. **Merge PR #26 into `main`.** This triggers **Deploy to Cloud Run (demo)**, about 5 minutes:
   - it builds the images from the merge commit;
   - the `academiapath-migrate` job applies migrations 0026 and 0027 (28 in total);
   - it deploys the API and the web app and smoke-tests them.

   Continue only when the run is green.
4. **Create the credentials secret** in Cloud Shell: `bash infra/demo-credentials.sh`. Then grant read access to Sagar and Claudio. This step may also come before step 3.
5. **Actions → Seed demo data (manual), mode `check`.** The first run also creates the job definition. Expect `Ready. Nothing was changed.` in Cloud Logging (Cloud Run job `academiapath-seed-demo`).
6. **Same workflow, mode `create`, confirm `academiapath-demo`.** Expect:
   - the accounts table;
   - the record counts;
   - `Sign-in check: 5/5`.

   Optionally run `create` again: every count shows 0 created.
7. **Retrieve the credentials and check the web app**, signing in as each account:
   - **Admin:** the overview shows 2 programs and 4 courses; **Announcements & calendar** shows *Cierre del semestre 2026-2*.
   - **Instructor:** **Teaching** lists the courses; the ITIL gradebook opens; the course calendar shows the review session.
   - **Teaching assistant:** **Read & grade**; no publishing controls in announcements.
   - **Reviewer:** **Content review** counts.
   - **Student:** three courses; unread announcements; the calendar; released grades in Project Management. Open the document *Service value chain overview* and download it, which proves the bucket holds the files.

**Rollback.** The migrations only add tables, so the previous revision runs on the new schema:

```bash
gcloud run services update-traffic academiapath-api --region=us-central1 --to-revisions=PREVIOUS_REVISION=100
gcloud run services update-traffic academiapath-web --region=us-central1 --to-revisions=PREVIOUS_REVISION=100
```

The demo data can stay. Never reset or delete the database.

**Without GitHub Actions.** In Cloud Shell, run the two commands of `seed-demo.yml` (`gcloud run jobs deploy …` with the deployed `migrate` image, then `gcloud run jobs execute academiapath-seed-demo --update-env-vars=DEMO_SEED_MODE=…,DEMO_SEED_CONFIRM=… --wait`).

### Cost

- **Cloud Run job:** billed only while it runs. It uses 1 vCPU and 1 GiB for about 1–2 minutes per run, which is within the Cloud Run free tier, or otherwise a fraction of a cent per run.
- **Secret Manager:** one secret. It is free within the monthly allowance (a few active versions); beyond it, about USD 0.06 per active version per month.
- **Cloud SQL and Cloud Storage:** a few hundred rows and three small documents, on the existing instance and bucket.
- **Nothing else new:** no new image (the job reuses the release's `migrate` image), no new instance, and no Vertex AI or other paid API call.

## Rules for changing the deployment

- **No secrets in Git:** they go to Secret Manager and are mounted with `--set-secrets`.
- **New environment variables:** add them to `deploy.yml` and document them in `cloud-run.env.example`. The local `.env.example` covers development only.
- **Runtime identity:** the services run as `academiapath-runtime`, never as the default Compute service account, which has Editor on the whole project.
- **Migrations:** schema changes go through Drizzle migrations. The workflow applies them automatically before the API deploy.
- **Merges deploy:** merging to `main` deploys, so keep `main` green and review infrastructure changes first.

## Known limitations

- **No demo users until the seed job runs.** The database is empty until someone runs `academiapath-seed-demo` (see "Demo users and courses" above). `db:seed:dev` and `db:seed:demo` refuse production, Cloud Run and Cloud SQL, and production issues no activation links.
- **Client IPs.** The web proxies `/api/*`, so the API sees Google front-end IPs. Login rate limits still work because they are keyed by email, but audit logs have no client IP. For production, put both services behind one external HTTPS load balancer with path routing and set `TRUST_PROXY` to its ranges.
- **Public services.** Both services allow unauthenticated access, which a public demo needs. The API still enforces its own Origin, CSRF and session checks.
- **JSON key.** `GCP_SA_KEY` is a long-lived credential. Replace it with Workload Identity Federation when possible.

## Next steps

- [ ] Seed job for demo users and courses (needed for the November 20 demo): prepared; run it after the AP-025 release (see "Release sequence")
- [ ] Remove the project-wide `roles/storage.objectAdmin` from `academiapath-runtime`; it keeps access to its own bucket
- [ ] Firebase Authentication on Identity Platform: console setup done; integration pending (see "Firebase Authentication" above and the functional spec)
- [ ] Vertex AI for the tutor and document summaries (the API uses a local mock today)
- [ ] Workload Identity Federation instead of the JSON key
- [ ] Load balancer, custom domain and Cloud Armor before production
