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
- [ ] Firebase Authentication on Identity Platform (see the functional spec, Authentication section)
- [ ] Vertex AI for the tutor and document summaries (the API uses a local mock today)
- [ ] Workload Identity Federation instead of the JSON key
- [ ] Load balancer, custom domain and Cloud Armor before production
