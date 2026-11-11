/**
 * ONE-OFF CLOUD DEMO SEED — synthetic users and demo courses for the AcademiaPath demo on Cloud Run.
 *
 * Runs only when explicitly executed as the `academiapath-seed-demo` Cloud Run job (or, for testing, against
 * a database on this machine); never on app start-up and never as part of a deployment. See infra/README.md.
 *
 *   DEMO_SEED_TARGET   cloud-demo | local
 *   DEMO_SEED_MODE     check (default, read-only) | create | reset-credentials
 *   DEMO_SEED_CONFIRM  academiapath-demo (cloud-demo) or local-demo (local); required unless mode is check
 *   DEMO_SEED_CONFIRM_RESET  reset-demo-credentials; required for reset-credentials
 *   DEMO_ACCOUNT_CREDENTIALS  JSON {"<email>": "<password>"} for the five role accounts (Secret Manager secret
 *                      academiapath-demo-credentials); locally DEMO_ACCOUNT_CREDENTIALS_FILE (chmod 600) instead
 *
 * - `check` verifies the environment, the schema, that the database holds only synthetic demo data, the
 *   document storage and the credentials, and changes nothing in the database.
 * - `create` creates what is missing: accounts (existing accounts keep their passwords), then the demo
 *   dataset through the real API. Re-running it creates nothing new.
 * - `reset-credentials` only replaces the five role accounts' passwords and ends their sessions.
 * Every mode ends by signing each role account in with its credential (create and reset) and records an
 * audit entry. Output never contains passwords, password hashes, session tokens or the database URL.
 */
import { pathToFileURL } from 'node:url';
import type { PoolClient } from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { auditLog } from '../src/db/schema/index.js';
import { LocalDocumentStorage } from '../src/documents/storage.js';
import { sessionActor, type Actor } from './demo/api.js';
import {
  createAccounts,
  displayName,
  inspectDatabase,
  parseDemoCredentials,
  readCredentialSource,
  resetCredentials,
  resolveSeedRun,
  ROLE_ACCOUNTS,
  runtimeGuardDeps,
  SeedRefused,
  verifySignIns,
  type GuardDeps,
} from './demo/cloud.js';
import { ACCOUNTS, type Persona } from './demo/content.js';
import { seedDemoDataset } from './seed-demo.js';

/** Exit codes: 0 done, 1 unexpected failure, 2 refused by the guard, 3 database not ready or not demo-only, 4 sign-in check failed. */
export const EXIT = { ok: 0, failed: 1, refused: 2, notReady: 3, signIn: 4 } as const;

/** Arbitrary constant for the PostgreSQL advisory lock that keeps two seed runs from overlapping. */
const SEED_LOCK = 4_172_025;

export async function runCloudDemoSeed(env: NodeJS.ProcessEnv = process.env, deps: GuardDeps = runtimeGuardDeps, log: (line: string) => void = console.log): Promise<number> {
  let run;
  let config;
  let credentials: Map<string, string> | null = null;
  try {
    run = await resolveSeedRun(env, deps);
    const raw = await readCredentialSource(env, run.target);
    if (run.mode !== 'check' || raw?.trim()) credentials = parseDemoCredentials(raw);
  } catch (error) {
    log(`REFUSED: ${error instanceof SeedRefused ? error.message : 'the seed could not start (details withheld).'}`);
    return EXIT.refused;
  }
  try {
    // The same configuration rules as the API (its messages name variables, never the database URL).
    config = loadConfig(env);
  } catch (error) {
    log(`REFUSED: configuration: ${error instanceof Error ? error.message : 'invalid'}.`);
    return EXIT.refused;
  }
  log(`AcademiaPath demo seed — target ${run.target}, mode ${run.mode}.`);

  const { db, pool } = createDatabase(run.databaseUrl);
  let lock: PoolClient | null = null;
  try {
    lock = await pool.connect();
    const locked = (await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [SEED_LOCK])).rows[0]?.ok;
    if (!locked) {
      log('REFUSED: another demo seed run is in progress.');
      return EXIT.refused;
    }

    // Private document storage must be writable now (and on Cloud Run, it is the mounted bucket).
    const storage = new LocalDocumentStorage(config.documents.storageDir);
    if (run.mode !== 'reset-credentials') {
      const probe = await storage.put(Buffer.from('academiapath demo seed storage probe'));
      const ok = (await storage.read(probe)).length > 0;
      await storage.remove(probe);
      if (!ok) {
        log('NOT READY: document storage did not return what was written.');
        return EXIT.notReady;
      }
      log('Document storage: writable.');
    }

    const inspection = await inspectDatabase(db, run.mode, storage);
    for (const warning of inspection.warnings) log(`WARNING: ${warning}`);
    if (inspection.problems.length) {
      for (const problem of inspection.problems) log(`NOT READY: ${problem}`);
      log('Nothing was changed.');
      return EXIT.notReady;
    }
    log(`Database: schema up to date and holds only synthetic demo data (${inspection.accounts.existing} of ${ROLE_ACCOUNTS.length} role accounts exist).`);

    if (run.mode === 'check') {
      if (!credentials) {
        log('NOT READY: no demo credentials are configured (secret academiapath-demo-credentials).');
        return EXIT.notReady;
      }
      log('Credentials: present and valid for the five role accounts (values not shown).');
      log('Ready. Nothing was changed.');
      return EXIT.ok;
    }

    const app = buildApp({ config: { ...config, loginRateLimit: { max: 100, windowMs: config.loginRateLimit.windowMs } }, database: db });
    await app.ready();
    const origin = config.allowedOrigins[0] ?? 'http://localhost:3000';
    let summary: Record<string, unknown>;
    try {
      if (run.mode === 'create') {
        const outcomes = await createAccounts(db, credentials!);
        log('Accounts:');
        for (const outcome of outcomes) {
          const role = ROLE_ACCOUNTS.find((a) => a.email === outcome.email)?.role ?? 'Supporting learner (no sign-in)';
          log(`  ${outcome.email.padEnd(34)} ${displayName(outcome.email).padEnd(26)} ${role.padEnd(38)} ${outcome.account}, password ${outcome.password}`);
        }
        const report = await seedDemoDataset(db, {
          env,
          uploadFilesDir: null,
          actors: async (datasetApp, datasetOrigin, datasetConfig) => {
            const opened: Array<() => Promise<void>> = [];
            const actors = {} as Record<Persona, Actor>;
            try {
              for (const persona of Object.keys(ACCOUNTS) as Persona[]) {
                const session = await sessionActor(datasetApp, db, datasetConfig, datasetOrigin, ACCOUNTS[persona]);
                opened.push(session.close);
                actors[persona] = session.actor;
              }
            } catch (error) {
              for (const close of opened) await close();
              throw error;
            }
            return { actors, close: async () => void (await Promise.all(opened.map((close) => close()))) };
          },
        });
        log('Demo records (created / already present):');
        for (const [kind, { created, existing }] of Object.entries(report.counts)) log(`  ${kind.padEnd(24)} ${String(created).padStart(3)} / ${existing}`);
        for (const course of report.courses) log(`  course ${course.code.padEnd(18)} ${course.status}`);
        summary = {
          accountsCreated: outcomes.filter((o) => o.account === 'created').length,
          passwordsSet: outcomes.filter((o) => o.password === 'set').length,
          recordsCreated: Object.values(report.counts).reduce((sum, c) => sum + c.created, 0),
        };
      } else {
        const results = await resetCredentials(db, credentials!);
        log('Credentials replaced for the five role accounts (values not shown):');
        for (const result of results) log(`  ${result.email.padEnd(34)} open sessions ended: ${result.sessionsEnded}`);
        summary = { passwordsReset: results.length };
      }

      const failed = await verifySignIns(app, origin, credentials!);
      summary.signInFailures = failed.length;
      await db.insert(auditLog).values({ action: 'system.demo_seed', entityType: 'system', metadata: { target: run.target, mode: run.mode, ...summary } });
      if (failed.length) {
        for (const email of failed) log(`SIGN-IN FAILED: ${email} does not accept the password in the credentials (an existing account keeps its password in mode "create"; use reset-credentials).`);
        return EXIT.signIn;
      }
      log(`Sign-in check: ${ROLE_ACCOUNTS.length}/${ROLE_ACCOUNTS.length} role accounts sign in with the configured credentials.`);
      log('Done.');
      return EXIT.ok;
    } finally {
      await app.close();
    }
  } catch (error) {
    log(`FAILED: ${error instanceof Error ? error.message : 'unexpected error'} (re-running is safe: every step skips what already exists).`);
    return EXIT.failed;
  } finally {
    if (lock) {
      await lock.query('SELECT pg_advisory_unlock($1)', [SEED_LOCK]).catch(() => undefined);
      lock.release();
    }
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCloudDemoSeed()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.log('FAILED: unexpected error.');
      process.exitCode = EXIT.failed;
    });
}
