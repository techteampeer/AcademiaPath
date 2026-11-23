/**
 * AP-OPS-03 storage recovery preview through the Cloud Storage JSON API (src/documents/approved-recovery.ts):
 *
 *   pnpm storage:recover:approved -- preview --bucket NAME --api-url URL [--prefix P] [--json]
 *
 * `preview` changes nothing and stores nothing: it prints what a recovery plan would contain (counts only, no storage
 * keys). Plans, approvals and execution are durable records that require a verified operator identity
 * (src/documents/operator-identity.ts); this build has no trusted identity provider outside the tests, so this command
 * offers no way to approve or apply anything. The AP-OPS-02 `apply --approve DIGEST` command was removed: a digest
 * identifies a plan, it does not authorize one.
 *
 * PRODUCTION RECOVERY IS NOT ENABLED IN THIS BUILD. This command refuses production, Cloud Run, any non-local database
 * and any storage API other than a local emulator (a loopback http address).
 */
import { pathToFileURL } from 'node:url';
import { createDatabase } from '../src/db/client.js';
import { previewRecovery } from '../src/documents/approved-recovery.js';
import { GcsJsonObjectStore } from '../src/documents/object-store.js';
import { isLocalDatabase } from './seed-dev-users.js';

/** 0: nothing to recover; 1: a plan would propose actions; 2: refused or uncertain; 3: not allowed here. */
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

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  const { command, flags, json } = parse(argv);
  if (command !== 'preview') {
    console.error(
      command === 'apply' || command === 'plan'
        ? `"${command}" is not available: recovery plans are approved and executed only as durable records by verified operators, and this build has no trusted operator identity.`
        : 'Usage: storage:recover:approved preview --bucket NAME --api-url URL [--prefix P] [--json]',
    );
    return APPROVED_EXIT.refused;
  }
  const refusal = approvedRecoveryRefusal(env, flags['api-url']);
  if (refusal) {
    console.error(`Refusing storage recovery preview: ${refusal}`);
    return APPROVED_EXIT.refused;
  }
  let store: GcsJsonObjectStore;
  try {
    store = new GcsJsonObjectStore({ bucket: flags.bucket ?? '', baseUrl: flags['api-url'], prefix: flags.prefix, getAccessToken: async () => EMULATOR_TOKEN });
  } catch (error) {
    console.error(`Refusing storage recovery preview: ${(error as Error).message}.`);
    return APPROVED_EXIT.refused;
  }
  const { db, pool } = createDatabase(env.DATABASE_URL);
  try {
    const preview = await previewRecovery({ db, store });
    if (json) console.log(JSON.stringify({ status: preview.status, refusal: preview.refusal, counts: preview.summary?.counts ?? null, truncated: preview.summary?.truncated ?? false }));
    else {
      const c = preview.summary?.counts;
      console.log(
        [
          `Storage recovery preview (nothing was changed or stored): ${preview.status.toUpperCase()}${preview.refusal ? ` (${preview.refusal})` : ''}`,
          `  Bucket ${store.bucket} · API ${store.endpoint}`,
          c ? `  Journal entries: ${c.journaled}; lease running: ${c.active}; abandoned: ${c.abandoned}${preview.summary!.truncated ? ' (more remain)' : ''}` : '',
          c ? `  A plan would propose: delete ${c.proposedDeletions}; forget missing ${c.forgetMissing}; forget referenced ${c.forgetReferenced}; uncertain ${c.uncertain}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    if (preview.status !== 'ready' || preview.summary!.counts.uncertain > 0) return APPROVED_EXIT.failed;
    const c = preview.summary!.counts;
    return c.proposedDeletions + c.forgetMissing + c.forgetReferenced > 0 ? APPROVED_EXIT.pending : APPROVED_EXIT.clean;
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
      console.error('Storage recovery preview failed unexpectedly; nothing was changed.');
      process.exitCode = APPROVED_EXIT.failed;
    });
}
