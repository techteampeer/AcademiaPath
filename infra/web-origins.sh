#!/usr/bin/env bash
# Prints the exact browser origins of the web service, comma-separated, for the API's APP_ORIGINS.
#
#   gcloud run services describe academiapath-web --region=us-central1 --format=json | bash infra/web-origins.sh "$WEB_URL"
#
# Cloud Run serves a service at its deterministic URL (https://SERVICE-PROJECT_NUMBER.REGION.run.app, passed as $1)
# and at its default URL (https://SERVICE-HASH-REGION_CODE.a.run.app, the service's status.url). Browsers sign in
# from whichever one they opened, so the API must accept every URL the service itself reports — and nothing else:
# only exact https://….run.app origins are kept, never wildcards. When the service does not exist yet (first
# deployment) or cannot be described, the output is just $1.
set -euo pipefail

canonical="${1:?usage: web-origins.sh CANONICAL_WEB_URL < service.json}"
jq -rs --arg canonical "$canonical" '
  (.[0] // {}) as $service
  | [$canonical, $service.status.url?]
    + (($service.metadata.annotations["run.googleapis.com/urls"]? // "[]") | (try fromjson catch []) | if type == "array" then . else [] end)
  | map(select(type == "string" and test("^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\\.run\\.app$")))
  | reduce .[] as $url ([]; if index([$url]) then . else . + [$url] end)
  | join(",")
'
