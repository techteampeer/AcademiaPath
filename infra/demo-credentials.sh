#!/usr/bin/env bash
# Creates the Secret Manager secret with unique passwords for the five demo role accounts, or adds a new
# version of it (rotation). Run from Cloud Shell, only with Sagar's approval: it creates a billable secret
# version (a few cents per month at most). Prints no password.
#
# The seed job (`academiapath-seed-demo`, see infra/README.md) reads the latest version: mode `create`
# gives new accounts these passwords; after a rotation, run mode `reset-credentials` to apply them.
set -euo pipefail

PROJECT_ID=elearning-514315
SECRET=academiapath-demo-credentials
RUNTIME_SA=academiapath-runtime@${PROJECT_ID}.iam.gserviceaccount.com

# 24 random letters and digits (about 140 bits) per account; nothing is echoed or stored on disk.
password() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-24; }
credentials() {
  printf '{"admin@academiapath.example":"%s","reviewer@academiapath.example":"%s","instructor@academiapath.example":"%s","ta@academiapath.example":"%s","student@academiapath.example":"%s"}' \
    "$(password)" "$(password)" "$(password)" "$(password)" "$(password)"
}

gcloud config set project "$PROJECT_ID" >/dev/null

if gcloud secrets describe "$SECRET" >/dev/null 2>&1; then
  credentials | gcloud secrets versions add "$SECRET" --data-file=- >/dev/null
  echo "Added a new version of ${SECRET}. Apply it with the seed job in mode reset-credentials."
else
  credentials | gcloud secrets create "$SECRET" --replication-policy=automatic --labels=app=academiapath --data-file=- >/dev/null
  echo "Created ${SECRET}."
fi

# Only the seed job's identity reads it; people are granted access one by one (see infra/README.md).
gcloud secrets add-iam-policy-binding "$SECRET" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor >/dev/null
echo "academiapath-runtime can read ${SECRET}. No password was printed."
