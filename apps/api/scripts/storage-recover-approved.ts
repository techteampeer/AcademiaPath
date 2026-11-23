/**
 * AP-OPS-02 approval-based storage recovery through the Cloud Storage JSON API (src/documents/approved-recovery.ts),
 * in two stages:
 *
 *   pnpm storage:recover:approved -- plan  --bucket NAME --api-url URL [--prefix P] [--ttl-minutes 60] --out plan.json
 *   pnpm storage:recover:approved -- apply --bucket NAME --api-url URL [--prefix P] --plan plan.json --approve DIGEST
 *
 * `plan` changes nothing: it writes the plan (no storage keys, only one-way references) and prints a summary with the
 * digest. `apply` acts only on that plan, with that digest typed back, before the plan expires, in the same
 * environment (database, storage API, bucket).
 *
 * PRODUCTION RECOVERY IS NOT ENABLED IN THIS BUILD. This command refuses production, Cloud Run, any non-local database
 * and any storage API other than a local emulator (a loopback http address): it cannot reach the real Cloud Storage
 * API. Enabling production recovery needs a separate, reviewed change and the approvals in
 * docs/production-storage-recovery.md; merging this code does not enable any deletion.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createDatabase } from '../src/db/client.js';
import { applyApprovedRecovery, planApprovedRecovery, type ApplyReport, type RecoveryPlan } from '../src/documents/approved-recovery.js';
import { GcsJsonObjectStore } from '../src/documents/object-store.js';
import { isLocalDatabase } from './seed-dev-users.js';

/** 0: nothing to do / done; 1: a plan awaits approval; 2: refused, uncertain or incomplete; 3: not allowed here. */
export const APPROVED_EXIT = { clean: 0, pending: 1, failed: 2, refused: 3 } as const;
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;
/** The local emulator accepts any token; no real credential is ever obtained by this command. */
const EMULATOR_TOKEN = 'local-emulator';

type Args = { command: string | undefined; flags: Record<string, string>; json: boolean };
function parse(argv: string[]): Args {
  const flags: Record<string, string> = {};
  let command: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--') continue;
    if (arg === '--json') json = true;
    else if (arg.startsWith('--')) flags[arg.slice(2)] = argv[(i += 1)] ?? '';
    else command ??= arg;
  }
  return { command, flags, json };
}

/** Why this command may not run here, or null. Production, Cloud Run, remote databases and the real API are refused. */
export function approvedRecoveryRefusal(env: NodeJS.ProcessEnv, apiUrl: string | undefined): string | null {
  if (env.NODE_ENV === 'production') return 'NODE_ENV is production: production recovery is not enabled in this build.';
  if (env.K_SERVICE || env.CLOUD_RUN_JOB) return 'this is a Cloud Run service or job: production recovery is not enabled in this build.';
  if (!env.DATABASE_URL) return 'DATABASE_URL is not set.';
  if (!isLocalDatabase(env.DATABASE_URL, env)) return 'DATABASE_URL is not a database on this machine (value not shown).';
  let url: URL;
  try {
    url = new URL(apiUrl ?? '');
  } catch {
    return '--api-url is missing or invalid.';
  }
  if (url.protocol !== 'http:' || !LOOPBACK.test(url.hostname)) return 'the storage API must be a local emulator (a loopback http address); the real Cloud Storage API is not enabled in this build.';
  return null;
}

/** The database's identity for approvals: host, port and name, never credentials. */
function databaseIdentity(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
}

function planSummary(plan: RecoveryPlan, file: string): string {
  const c = plan.counts;
  return [
    `Storage recovery plan (dry run: nothing was changed): ${plan.status.toUpperCase()}${plan.refusal ? ` (${plan.refusal})` : ''}`,
    `  Bucket ${plan.environment.bucket} · API ${plan.environment.endpoint} · database ${plan.environment.database}`,
    `  Journal entries: ${c.journaled}; lease running (left alone): ${c.active}; abandoned: ${c.abandoned}${plan.truncated ? ' (more remain: run again after this plan)' : ''}`,
    `  Proposed: delete ${c.proposedDeletions} object(s) at their observed generation; forget ${c.forgetMissing} entr(y/ies) whose file is already gone; forget ${c.forgetReferenced} entr(y/ies) whose file documents use`,
    `  Uncertain, left alone: ${c.uncertain}`,
    `  Expires: ${plan.expiresAt}`,
    `  Digest: ${plan.digest}`,
    plan.status === 'ready' && plan.items.length ? `To approve: apply --plan ${file} --approve <digest> with the same bucket and API, before it expires.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function applySummary(report: ApplyReport): string {
  return [
    `Storage recovery apply: ${report.status.toUpperCase()}${report.refusal ? ` (${report.refusal}: nothing was changed)` : ''}`,
    ...Object.entries(report.counts).map(([outcome, count]) => `  ${outcome}: ${count}`),
  ].join('\n');
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  const { command, flags, json } = parse(argv);
  if (command !== 'plan' && command !== 'apply') {
    console.error('Usage: storage:recover:approved plan|apply --bucket NAME --api-url URL ... (see the file header)');
    return APPROVED_EXIT.refused;
  }
  const refusal = approvedRecoveryRefusal(env, flags['api-url']);
  if (refusal) {
    console.error(`Refusing approved storage recovery: ${refusal}`);
    return APPROVED_EXIT.refused;
  }
  let store: GcsJsonObjectStore;
  try {
    store = new GcsJsonObjectStore({ bucket: flags.bucket ?? '', baseUrl: flags['api-url'], prefix: flags.prefix, getAccessToken: async () => EMULATOR_TOKEN });
  } catch (error) {
    console.error(`Refusing approved storage recovery: ${(error as Error).message}.`);
    return APPROVED_EXIT.refused;
  }
  const { db, pool } = createDatabase(env.DATABASE_URL);
  const deps = { db, store, database: databaseIdentity(env.DATABASE_URL!) };
  try {
    if (command === 'plan') {
      const ttl = Number(flags['ttl-minutes'] ?? 60);
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > 24 * 60 || !flags.out) {
        console.error('plan needs --out FILE and an integer --ttl-minutes between 1 and 1440.');
        return APPROVED_EXIT.refused;
      }
      const plan = await planApprovedRecovery(deps, { expiresInSeconds: ttl * 60 });
      // Never overwrites an existing plan file; readable by the operator only.
      await writeFile(flags.out, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      console.log(json ? JSON.stringify({ status: plan.status, refusal: plan.refusal, counts: plan.counts, expiresAt: plan.expiresAt, digest: plan.digest }) : planSummary(plan, flags.out));
      if (plan.status !== 'ready' || plan.counts.uncertain > 0) return APPROVED_EXIT.failed;
      return plan.items.length ? APPROVED_EXIT.pending : APPROVED_EXIT.clean;
    }
    if (!flags.plan || !flags.approve) {
      console.error('apply needs --plan FILE and --approve DIGEST (the digest printed by plan).');
      return APPROVED_EXIT.failed;
    }
    let plan: unknown;
    try {
      plan = JSON.parse(await readFile(flags.plan, 'utf8'));
    } catch {
      console.error('The plan file could not be read.');
      return APPROVED_EXIT.failed;
    }
    const report = await applyApprovedRecovery(deps, { plan, approvedDigest: flags.approve });
    console.log(json ? JSON.stringify(report, null, 2) : applySummary(report));
    return report.status === 'complete' ? APPROVED_EXIT.clean : APPROVED_EXIT.failed;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error('Approved storage recovery failed unexpectedly; every entry it did not finish is unchanged.');
      process.exitCode = APPROVED_EXIT.failed;
    });
}
