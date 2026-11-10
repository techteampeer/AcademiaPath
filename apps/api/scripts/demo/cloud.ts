/**
 * The approved cloud demo seed (a one-off Cloud Run job, never part of a deployment or app start-up):
 * environment guard, demo credentials, the unexpected-data check, account provisioning and the separate
 * credential reset. The command line lives in `scripts/seed-cloud-demo.ts`; see infra/README.md.
 *
 * Credentials are chosen outside the job (Secret Manager secret `academiapath-demo-credentials`, mounted as
 * DEMO_ACCOUNT_CREDENTIALS), hashed with the API's own Argon2id settings and never logged.
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { hashPassword, isWeakPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../src/auth/password.js';
import type { Database } from '../../src/db/client.js';
import { auditLog, courseDocuments, courses, courseTemplates, programs, sessions, terms, userCredentials, users } from '../../src/db/schema/index.js';
import { DEV_USERS, isLocalDatabase, type SyntheticUser } from '../seed-dev-users.js';
import { ACCOUNTS, COURSES, DEMO_LEARNERS, PROGRAMS, TERMS } from './content.js';

export const CLOUD_DEMO = {
  projectId: 'elearning-514315',
  jobName: 'academiapath-seed-demo',
  sqlInstance: 'elearning-514315:us-central1:academiapath-db',
  database: 'academiapath',
  documentsMount: '/mnt/documents',
} as const;

export const SEED_TARGETS = ['cloud-demo', 'local'] as const;
export const SEED_MODES = ['check', 'create', 'reset-credentials'] as const;
export type SeedTarget = (typeof SEED_TARGETS)[number];
export type SeedMode = (typeof SEED_MODES)[number];

/** Typed confirmations: creating needs the target's phrase; resetting credentials needs a second one. */
export const CONFIRM: Record<SeedTarget, string> = { 'cloud-demo': 'academiapath-demo', local: 'local-demo' };
export const CONFIRM_RESET = 'reset-demo-credentials';

/** The five sign-in accounts handed to the demo team, one per role. */
export const ROLE_ACCOUNTS: ReadonlyArray<{ email: string; role: string }> = [
  { email: ACCOUNTS.admin, role: 'Administrator (system role)' },
  { email: ACCOUNTS.reviewer, role: 'Design team (course role)' },
  { email: ACCOUNTS.instructor, role: 'Instructor (course role)' },
  { email: ACCOUNTS.ta, role: 'Non-editing instructor (course role)' },
  { email: ACCOUNTS.student, role: 'Student (course role)' },
];
const ROLE_EMAILS = new Set(ROLE_ACCOUNTS.map((a) => a.email));

/** Every synthetic account: the five role accounts plus two learners that never get a password. */
const SYNTHETIC: ReadonlyArray<SyntheticUser> = [...DEV_USERS, ...DEMO_LEARNERS];
const SYNTHETIC_BY_EMAIL = new Map(SYNTHETIC.map((u) => [u.email, u]));
export const displayName = (email: string) => {
  const user = SYNTHETIC_BY_EMAIL.get(email);
  return user ? `${user.givenName} ${user.familyName}` : email;
};

// ---------------------------------------------------------------------------------------------------------
// Environment guard

export type GuardDeps = {
  /** The Google Cloud project of the machine (metadata server), or null when there is none. */
  projectId: () => Promise<string | null>;
  /** Whether a directory is a mount point (listed in /proc/mounts, or on another device than its parent). */
  isMountPoint: (path: string) => Promise<boolean>;
};

export const runtimeGuardDeps: GuardDeps = {
  projectId: async () => {
    try {
      const response = await fetch('http://metadata.google.internal/computeMetadata/v1/project/project-id', {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(2000),
      });
      return response.ok ? (await response.text()).trim() : null;
    } catch {
      return null;
    }
  },
  isMountPoint: async (path) => {
    const listed = await readFile('/proc/mounts', 'utf8')
      .then((text) => text.split('\n').some((line) => line.split(' ')[1] === path))
      .catch(() => false);
    if (listed) return true;
    const [own, parent] = await Promise.all([stat(path).catch(() => null), stat(dirname(path)).catch(() => null)]);
    return Boolean(own?.isDirectory() && parent && own.dev !== parent.dev);
  },
};

export class SeedRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedRefused';
  }
}

export type SeedRun = { target: SeedTarget; mode: SeedMode; databaseUrl: string };

/**
 * Decides whether this process may seed, and what. Never prints the database URL or any credential.
 * - `cloud-demo`: only as the `academiapath-seed-demo` Cloud Run job in project elearning-514315, with
 *   NODE_ENV=production, the academiapath database on the academiapath-db instance and the documents bucket
 *   mounted at /mnt/documents.
 * - `local`: only outside Cloud Run, without NODE_ENV=production, against a database on this machine.
 */
export async function resolveSeedRun(env: NodeJS.ProcessEnv, deps: GuardDeps): Promise<SeedRun> {
  const target = env.DEMO_SEED_TARGET as SeedTarget;
  if (!SEED_TARGETS.includes(target)) throw new SeedRefused('DEMO_SEED_TARGET must be "cloud-demo" or "local".');
  const mode = (env.DEMO_SEED_MODE?.trim() || 'check') as SeedMode;
  if (!SEED_MODES.includes(mode)) throw new SeedRefused('DEMO_SEED_MODE must be "check", "create" or "reset-credentials".');
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new SeedRefused('DATABASE_URL is not set.');
  if (mode !== 'check' && env.DEMO_SEED_CONFIRM !== CONFIRM[target]) {
    throw new SeedRefused(`Refusing mode "${mode}": set DEMO_SEED_CONFIRM=${CONFIRM[target]} to confirm the ${target} target.`);
  }
  if (mode === 'reset-credentials' && env.DEMO_SEED_CONFIRM_RESET !== CONFIRM_RESET) {
    throw new SeedRefused(`Refusing to reset credentials: also set DEMO_SEED_CONFIRM_RESET=${CONFIRM_RESET}.`);
  }

  if (target === 'local') {
    if (env.NODE_ENV === 'production') throw new SeedRefused('Refusing the local target: NODE_ENV is production.');
    if (env.K_SERVICE || env.CLOUD_RUN_JOB) throw new SeedRefused('Refusing the local target inside Cloud Run.');
    if (!isLocalDatabase(databaseUrl, env)) throw new SeedRefused('Refusing the local target: DATABASE_URL is not a database on this machine.');
    return { target, mode, databaseUrl };
  }

  if (env.NODE_ENV !== 'production') throw new SeedRefused('The cloud-demo target runs only with NODE_ENV=production.');
  if (env.K_SERVICE) throw new SeedRefused('Refusing to seed from a Cloud Run service; only the academiapath-seed-demo job may seed.');
  if (env.CLOUD_RUN_JOB !== CLOUD_DEMO.jobName) throw new SeedRefused(`Refusing: this is not the ${CLOUD_DEMO.jobName} Cloud Run job.`);
  if ((await deps.projectId()) !== CLOUD_DEMO.projectId) throw new SeedRefused('Refusing: this is not the approved AcademiaPath demo project.');
  let socket: string | null = null;
  let database = '';
  try {
    const url = new URL(databaseUrl);
    socket = url.searchParams.get('host');
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    throw new SeedRefused('DATABASE_URL is not a valid connection URL (value not shown).');
  }
  if (socket !== `/cloudsql/${CLOUD_DEMO.sqlInstance}` || database !== CLOUD_DEMO.database) {
    throw new SeedRefused(`Refusing: DATABASE_URL is not the approved demo database (${CLOUD_DEMO.database} on ${CLOUD_DEMO.sqlInstance}); value not shown.`);
  }
  if (env.DOCUMENT_STORAGE_DIR !== CLOUD_DEMO.documentsMount) throw new SeedRefused(`DOCUMENT_STORAGE_DIR must be ${CLOUD_DEMO.documentsMount} (the documents bucket).`);
  if (!(await deps.isMountPoint(CLOUD_DEMO.documentsMount))) {
    throw new SeedRefused(`Refusing: nothing is mounted at ${CLOUD_DEMO.documentsMount}, so uploaded demo documents would be lost with the container.`);
  }
  return { target, mode, databaseUrl };
}

// ---------------------------------------------------------------------------------------------------------
// Credentials

/** Where the credentials come from: the secret-backed variable, or (local only) a file only its owner can read. */
export async function readCredentialSource(env: NodeJS.ProcessEnv, target: SeedTarget): Promise<string | undefined> {
  const file = env.DEMO_ACCOUNT_CREDENTIALS_FILE?.trim();
  if (!file) return env.DEMO_ACCOUNT_CREDENTIALS;
  if (target !== 'local') throw new SeedRefused('DEMO_ACCOUNT_CREDENTIALS_FILE is for the local target only; the cloud job reads the mounted secret.');
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new SeedRefused('DEMO_ACCOUNT_CREDENTIALS_FILE does not point to a file.');
  if ((info.mode & 0o077) !== 0) throw new SeedRefused('DEMO_ACCOUNT_CREDENTIALS_FILE must be readable by its owner only (chmod 600).');
  return readFile(file, 'utf8');
}

/**
 * Parses {"<email>": "<password>", ...} for exactly the five role accounts. Passwords must follow the
 * activation policy (12–256 characters, not built from the email name, at least 5 distinct characters) and
 * differ from each other. Error messages name accounts, never values.
 */
export function parseDemoCredentials(raw: string | undefined): Map<string, string> {
  if (!raw?.trim()) throw new SeedRefused('No demo credentials: DEMO_ACCOUNT_CREDENTIALS is empty (mount the academiapath-demo-credentials secret).');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SeedRefused('The demo credentials are not valid JSON (contents not shown).');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SeedRefused('The demo credentials must be a JSON object of email → password.');
  const problems: string[] = [];
  const credentials = new Map<string, string>();
  let unexpected = 0;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const email = key.trim().toLowerCase();
    if (!ROLE_EMAILS.has(email)) unexpected += 1;
    else if (typeof value !== 'string') problems.push(`${email}: the password must be a string`);
    else credentials.set(email, value);
  }
  if (unexpected) problems.push(`${unexpected} entr${unexpected === 1 ? 'y is' : 'ies are'} not one of the five demo role accounts`);
  for (const { email } of ROLE_ACCOUNTS) {
    const password = credentials.get(email);
    if (password === undefined) {
      if (!problems.some((p) => p.startsWith(email))) problems.push(`${email}: missing`);
      continue;
    }
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) problems.push(`${email}: must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters`);
    else if (isWeakPassword(password, email)) problems.push(`${email}: too weak (contains the email name or fewer than 5 distinct characters)`);
  }
  if (new Set(credentials.values()).size !== credentials.size) problems.push('every account needs a different password');
  if (problems.length) throw new SeedRefused(`Demo credentials rejected: ${problems.join('; ')}.`);
  return credentials;
}

// ---------------------------------------------------------------------------------------------------------
// What is already in the database

export type Inspection = { problems: string[]; warnings: string[]; accounts: { existing: number; withPassword: number } };
export type DocumentStore = { read(key: string): Promise<Buffer> };

const MIGRATION_JOURNAL = new URL('../../drizzle/meta/_journal.json', import.meta.url);
const sample = (values: string[]) => `${values.slice(0, 5).join(', ')}${values.length > 5 ? ', …' : ''}`;

/**
 * Refuses anything that is not the synthetic demo: accounts outside the demo set, demo accounts with another
 * system role, and (except for a credential reset, which only touches the five role accounts) academic
 * records that are not demo fixtures or document rows whose stored file is missing. Read-only.
 */
export async function inspectDatabase(db: Database, mode: SeedMode, store: DocumentStore): Promise<Inspection> {
  const problems: string[] = [];
  const warnings: string[] = [];

  const journal = JSON.parse(await readFile(MIGRATION_JOURNAL, 'utf8')) as { entries: Array<{ when: number }> };
  try {
    const result = await db.execute(sql`SELECT count(*)::int AS n, max(created_at)::text AS last FROM drizzle.__drizzle_migrations`);
    const row = result.rows[0] as { n: number; last: string | null } | undefined;
    if (!row || row.n !== journal.entries.length || row.last !== String(journal.entries.at(-1)?.when)) {
      problems.push(`the database is not on the latest schema (${row?.n ?? 0} of ${journal.entries.length} migrations applied); run the academiapath-migrate job first`);
    }
  } catch {
    problems.push('no migrations have been applied; run the academiapath-migrate job first');
  }
  if (problems.length) return { problems, warnings, accounts: { existing: 0, withPassword: 0 } };

  const accounts = await db
    .select({ email: users.email, systemRole: users.systemRole, isActive: users.isActive, hasPassword: sql<boolean>`${userCredentials.userId} IS NOT NULL` })
    .from(users)
    .leftJoin(userCredentials, eq(userCredentials.userId, users.id));
  const foreign = accounts.filter((a) => !SYNTHETIC_BY_EMAIL.has(a.email.toLowerCase()));
  if (foreign.length) problems.push(`${foreign.length} account(s) are not synthetic demo accounts (not shown); this database is not the empty demo database`);
  for (const account of accounts) {
    const expected = SYNTHETIC_BY_EMAIL.get(account.email.toLowerCase());
    if (!expected) continue;
    if (account.systemRole !== expected.systemRole) problems.push(`${account.email} has system role "${account.systemRole}", expected "${expected.systemRole}"`);
    if (!account.isActive) warnings.push(`${account.email} is deactivated and will not be able to sign in`);
    if (!ROLE_EMAILS.has(account.email.toLowerCase()) && account.hasPassword) warnings.push(`${account.email} has a password, although supporting learners normally have none`);
  }
  const demo = accounts.filter((a) => ROLE_EMAILS.has(a.email.toLowerCase()));
  const summary = { existing: demo.length, withPassword: demo.filter((a) => a.hasPassword).length };

  if (mode === 'reset-credentials') {
    if (summary.existing !== ROLE_ACCOUNTS.length) problems.push('not all five demo role accounts exist; run mode "create" first');
    return { problems, warnings, accounts: summary };
  }

  const unknown = async (label: string, rows: Array<{ code: string }>, allowed: Iterable<string>) => {
    const allow = new Set(allowed);
    const extra = rows.map((r) => r.code).filter((code) => !allow.has(code));
    if (extra.length) problems.push(`${extra.length} ${label} are not demo fixtures (${sample(extra)})`);
  };
  await unknown('programs', await db.select({ code: programs.code }).from(programs), PROGRAMS.map((p) => p.code));
  await unknown('terms', await db.select({ code: terms.code }).from(terms), TERMS.map((t) => t.code));
  await unknown('subjects', await db.select({ code: courseTemplates.code }).from(courseTemplates), COURSES.map((c) => c.subject.code));
  await unknown('courses', await db.select({ code: courses.code }).from(courses), COURSES.map((c) => c.code));

  const stored = await db.select({ key: courseDocuments.storageKey }).from(courseDocuments);
  let missing = 0;
  for (const { key } of stored) await store.read(key).catch(() => (missing += 1));
  if (missing) problems.push(`${missing} uploaded document file(s) are missing from document storage (was the bucket mounted when they were uploaded?)`);
  return { problems, warnings, accounts: summary };
}

// ---------------------------------------------------------------------------------------------------------
// Accounts: creating (never overwrites) and resetting credentials (explicit, separate mode)

export type AccountOutcome = { email: string; account: 'created' | 'existing'; password: 'set' | 'unchanged' | 'none' };

/**
 * Creates missing synthetic accounts. A new role account gets its password from the credentials; an existing
 * account keeps its password (use reset-credentials to change it), except a role account that never had one.
 * The two supporting learners never get a password, so nobody can sign in as them.
 */
export async function createAccounts(db: Database, credentials: Map<string, string>): Promise<AccountOutcome[]> {
  const hashes = new Map<string, string>();
  for (const [email, password] of credentials) hashes.set(email, await hashPassword(password));
  return db.transaction(async (tx) => {
    const outcomes: AccountOutcome[] = [];
    for (const spec of SYNTHETIC) {
      const isRole = ROLE_EMAILS.has(spec.email);
      const [existing] = await tx
        .select({ id: users.id, hasPassword: sql<boolean>`${userCredentials.userId} IS NOT NULL` })
        .from(users)
        .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
        .where(sql`lower(${users.email}) = lower(${spec.email})`)
        .limit(1);
      let userId = existing?.id;
      if (!userId) {
        const [row] = await tx.insert(users).values(spec).returning({ id: users.id });
        if (!row) throw new Error(`Could not create ${spec.email}`);
        userId = row.id;
        await tx.insert(auditLog).values({ action: 'user.created', entityType: 'user', entityId: userId, metadata: { source: 'demo_seed', systemRole: spec.systemRole } });
      }
      let password: AccountOutcome['password'] = isRole ? 'unchanged' : 'none';
      if (isRole && !existing?.hasPassword) {
        await tx.insert(userCredentials).values({ userId, passwordHash: hashes.get(spec.email)! });
        await tx.insert(auditLog).values({ action: 'user.password_set', entityType: 'user', entityId: userId, metadata: { source: 'demo_seed' } });
        password = 'set';
      }
      outcomes.push({ email: spec.email, account: existing ? 'existing' : 'created', password });
    }
    return outcomes;
  });
}

/** Replaces the passwords of the five role accounts only and ends their open sessions. Audited. */
export async function resetCredentials(db: Database, credentials: Map<string, string>): Promise<Array<{ email: string; sessionsEnded: number }>> {
  const hashes = new Map<string, string>();
  for (const [email, password] of credentials) hashes.set(email, await hashPassword(password));
  return db.transaction(async (tx) => {
    const results: Array<{ email: string; sessionsEnded: number }> = [];
    for (const { email } of ROLE_ACCOUNTS) {
      const [user] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = lower(${email})`).limit(1);
      if (!user) throw new SeedRefused(`${email} does not exist; run mode "create" first.`);
      const passwordHash = hashes.get(email)!;
      await tx
        .insert(userCredentials)
        .values({ userId: user.id, passwordHash })
        .onConflictDoUpdate({ target: userCredentials.userId, set: { passwordHash, updatedAt: new Date() } });
      const ended = await tx
        .update(sessions)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      await tx.insert(auditLog).values({ action: 'user.password_reset', entityType: 'user', entityId: user.id, metadata: { source: 'demo_seed', sessionsEnded: ended.length } });
      results.push({ email, sessionsEnded: ended.length });
    }
    return results;
  });
}

/**
 * Signs each role account in through the real login route with its credential, then signs out again.
 * Returns the accounts that could not sign in (never the reason's details beyond the status).
 */
export async function verifySignIns(app: FastifyInstance, origin: string, credentials: Map<string, string>): Promise<string[]> {
  const failed: string[] = [];
  for (const { email } of ROLE_ACCOUNTS) {
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { email, password: credentials.get(email) } });
    if (login.statusCode !== 200) {
      failed.push(email);
      continue;
    }
    const cookies = Object.fromEntries(login.cookies.map((c) => [c.name, c.value]));
    const { csrfToken } = login.json() as { csrfToken: string };
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', cookies, headers: { origin, 'x-csrf-token': csrfToken } });
  }
  return failed;
}
