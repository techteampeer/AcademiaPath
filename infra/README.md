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

## Rules for changing the deployment

- **No secrets in Git:** they go to Secret Manager and are mounted with `--set-secrets`.
- **New environment variables:** add them to `deploy.yml` and document them in `cloud-run.env.example`. The local `.env.example` covers development only.
- **Runtime identity:** the services run as `academiapath-runtime`, never as the default Compute service account, which has Editor on the whole project.
- **Migrations:** schema changes go through Drizzle migrations. The workflow applies them automatically before the API deploy.
- **Merges deploy:** merging to `main` deploys, so keep `main` green and review infrastructure changes first.

## Known limitations

- **No demo users yet.** The database is empty. `db:seed:dev` and `db:seed:demo` refuse `NODE_ENV=production`, and production issues no activation links. A one-off Cloud Run job that seeds the synthetic users and demo courses, with the documents bucket mounted, is still needed.
- **Client IPs.** The web proxies `/api/*`, so the API sees Google front-end IPs. Login rate limits still work because they are keyed by email, but audit logs have no client IP. For production, put both services behind one external HTTPS load balancer with path routing and set `TRUST_PROXY` to its ranges.
- **Public services.** Both services allow unauthenticated access, which a public demo needs. The API still enforces its own Origin, CSRF and session checks.
- **JSON key.** `GCP_SA_KEY` is a long-lived credential. Replace it with Workload Identity Federation when possible.

## Next steps

- [ ] Seed job for demo users and courses (needed for the November 20 demo)
- [ ] Remove the project-wide `roles/storage.objectAdmin` from `academiapath-runtime`; it keeps access to its own bucket
- [ ] Firebase Authentication on Identity Platform: console setup done; integration pending (see "Firebase Authentication" above and the functional spec)
- [ ] Vertex AI for the tutor and document summaries (the API uses a local mock today)
- [ ] Workload Identity Federation instead of the JSON key
- [ ] Load balancer, custom domain and Cloud Armor before production
