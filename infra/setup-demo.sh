#!/usr/bin/env bash
# One-time setup of the AcademiaPath demo resources in elearning-514315, run from Cloud Shell.
# Creates billable resources (Cloud SQL charges while the instance exists). Safe to re-run:
# each step skips what already exists. Prints no secrets.
set -euo pipefail

PROJECT_ID=elearning-514315
REGION=us-central1
SQL_INSTANCE=academiapath-db
DB_NAME=academiapath
DB_USER=academiapath_app
BUCKET=elearning-514315-academiapath-files
RUNTIME_SA=academiapath-runtime@${PROJECT_ID}.iam.gserviceaccount.com
DEPLOYER_SA=academiapath-deployer@${PROJECT_ID}.iam.gserviceaccount.com

gcloud config set project "$PROJECT_ID" >/dev/null

echo "== Deployer can push images (repeat of the step that failed) =="
gcloud artifacts repositories add-iam-policy-binding academiapath --location="$REGION" \
  --member="serviceAccount:${DEPLOYER_SA}" --role=roles/artifactregistry.writer >/dev/null

echo "== Cloud SQL for PostgreSQL (smallest shared-core tier, for the demo) =="
if ! gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
  gcloud sql instances create "$SQL_INSTANCE" \
    --database-version=POSTGRES_16 --edition=ENTERPRISE --tier=db-f1-micro \
    --region="$REGION" --storage-size=10 --storage-auto-increase \
    --backup-start-time=07:00 --labels=app=academiapath
fi
gcloud sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE" >/dev/null 2>&1 \
  || gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE"

echo "== Database user and DATABASE_URL secret =="
if ! gcloud secrets describe academiapath-db-url >/dev/null 2>&1; then
  DB_PASSWORD="$(openssl rand -hex 24)"
  gcloud sql users create "$DB_USER" --instance="$SQL_INSTANCE" --password="$DB_PASSWORD"
  printf 'postgresql://%s:%s@localhost/%s?host=/cloudsql/%s:%s:%s' \
    "$DB_USER" "$DB_PASSWORD" "$DB_NAME" "$PROJECT_ID" "$REGION" "$SQL_INSTANCE" \
    | gcloud secrets create academiapath-db-url --data-file=- --labels=app=academiapath
  unset DB_PASSWORD
fi

echo "== Private bucket for uploaded documents =="
if ! gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET}" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention
  gcloud storage buckets update "gs://${BUCKET}" --update-labels=app=academiapath
fi

echo "== Runtime account: storage access limited to its own bucket =="
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/storage.objectAdmin >/dev/null

echo "Done. Next: add the GCP_SA_KEY secret in GitHub and run the 'Deploy to Cloud Run (demo)' workflow."
