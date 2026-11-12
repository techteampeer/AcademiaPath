#!/usr/bin/env bash
# AcademiaPath browser regression suite (EN/ES localization, five roles, navigation feedback, request budgets).
#
# Runs against the PRODUCTION BUILD on a DISPOSABLE local PostgreSQL database with synthetic demo data only:
#   1. creates a fresh database on the server in E2E_PG_ADMIN_URL, migrates it and runs the local demo seed
#      with a random one-time password (never printed);
#   2. starts the built API (dist/server.js) and `next start` on localhost;
#   3. runs `node --test` over e2e/*.test.ts, or the benchmark with `e2e/run.sh bench <label>`;
#   4. stops both servers and drops the database.
#
# Prerequisites: `pnpm install && pnpm build` (the web build must target API_ORIGIN=http://127.0.0.1:$E2E_API_PORT,
# the default 4000), a local PostgreSQL 16 superuser URL, and Playwright 1.63.0 with Chromium. Playwright is not a
# workspace dependency (it would add ~18 MB to the deployable images): it is taken from $PLAYWRIGHT_NODE_MODULES or,
# failing that, installed once into e2e/.tools (git-ignored).
#
# Usage:
#   E2E_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres e2e/run.sh            # all tests
#   E2E_PG_ADMIN_URL=... e2e/run.sh test e2e/l10n.test.ts                                  # one file
#   E2E_PG_ADMIN_URL=... e2e/run.sh bench after                                            # e2e/results/bench-after.json
# Never point E2E_PG_ADMIN_URL at a shared, cloud or production server.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E="$ROOT/e2e"
MODE="${1:-test}"
ADMIN_URL="${E2E_PG_ADMIN_URL:?Set E2E_PG_ADMIN_URL to a disposable local PostgreSQL server (superuser URL)}"
case "$ADMIN_URL" in
  *localhost*|*127.0.0.1*|*/tmp*) ;;
  *) echo "Refusing to run: E2E_PG_ADMIN_URL must point at a local disposable server." >&2; exit 2 ;;
esac
API_PORT="${E2E_API_PORT:-4000}"
WEB_PORT="${E2E_WEB_PORT:-3000}"
DB="ap_e2e_$(date +%s)_$$"
DB_URL="${ADMIN_URL%/*}/$DB"
WORK="$(mktemp -d)"

# Playwright: the caller's copy, else a pinned copy in e2e/.tools (no browsers are downloaded if already present).
if [ -z "${PLAYWRIGHT_NODE_MODULES:-}" ]; then
  PLAYWRIGHT_NODE_MODULES="$E2E/.tools/node_modules"
  if [ ! -d "$PLAYWRIGHT_NODE_MODULES/playwright" ]; then
    npm install --silent --no-save --no-package-lock --prefix "$E2E/.tools" playwright@1.63.0
    "$PLAYWRIGHT_NODE_MODULES/.bin/playwright" install chromium
  fi
fi
export PLAYWRIGHT_NODE_MODULES

psql_admin() { node -e '
  const [url, sql] = process.argv.slice(1);
  import(process.env.PG_MODULE).then(async ({ default: pg }) => { const c = new pg.Client({ connectionString: url }); await c.connect(); await c.query(sql); await c.end(); });
' "$ADMIN_URL" "$1"; }
export PG_MODULE="$ROOT/apps/api/node_modules/pg/lib/index.js"

API_PID=""; WEB_PID=""
cleanup() {
  if [ -n "$WEB_PID" ]; then kill "$WEB_PID" 2>/dev/null || true; fi
  if [ -n "$API_PID" ]; then kill "$API_PID" 2>/dev/null || true; fi
  wait 2>/dev/null || true
  psql_admin "DROP DATABASE IF EXISTS $DB WITH (FORCE)" || true
  rm -rf "$WORK"
}
trap cleanup EXIT

psql_admin "CREATE DATABASE $DB"
export DATABASE_URL="$DB_URL"
DEV_SEED_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("base64url"))')"
export DEV_SEED_PASSWORD
export DOCUMENT_STORAGE_DIR="$WORK/documents" DEMO_FILES_DIR="$WORK/demo-files"
(cd "$ROOT" && pnpm -s db:migrate > "$WORK/migrate.log" 2>&1) || { tail -20 "$WORK/migrate.log"; exit 1; }
(cd "$ROOT" && pnpm -s db:seed:demo > "$WORK/seed.log" 2>&1) || { tail -20 "$WORK/seed.log"; exit 1; }

BASE="http://localhost:$WEB_PORT"
(cd "$ROOT/apps/api" && NODE_ENV=development API_PORT="$API_PORT" APP_ORIGINS="$BASE" LOG_LEVEL=warn exec node dist/server.js > "$WORK/api.log" 2>&1) &
API_PID=$!
(cd "$ROOT/apps/web" && API_ORIGIN="http://127.0.0.1:$API_PORT" exec node node_modules/next/dist/bin/next start --port "$WEB_PORT" > "$WORK/web.log" 2>&1) &
WEB_PID=$!
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$API_PORT/api/v1/health" > /dev/null 2>&1 && break; sleep 1; done
for _ in $(seq 60); do curl -sf -o /dev/null "$BASE/login" 2>/dev/null && break; sleep 1; done

export E2E_BASE="$BASE" E2E_PASSWORD="$DEV_SEED_PASSWORD"
FILES=()
if [ "$MODE" = "test" ]; then
  shift || true
  for f in "$@"; do FILES+=("$(cd "$(dirname "$f")" && pwd)/$(basename "$f")"); done
  [ ${#FILES[@]} -eq 0 ] && FILES=("$E2E"/*.test.ts)
fi
cd "$ROOT/apps/api" # tsx is resolved from the API workspace
STATUS=0
if [ "$MODE" = "bench" ]; then
  node --import tsx "$E2E/bench.ts" "${2:-local}" || STATUS=$?
else
  node --import tsx --test --test-concurrency=1 "${FILES[@]}" || STATUS=$?
fi
if grep -qF "$DEV_SEED_PASSWORD" "$WORK/api.log" "$WORK/web.log" "$WORK/seed.log"; then echo "Seed password found in a log." >&2; STATUS=1; fi
exit $STATUS
