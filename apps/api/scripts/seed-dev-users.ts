/**
 * DEVELOPMENT ONLY: provisions synthetic users for local testing.
 *
 *   DEV_SEED_PASSWORD=... pnpm db:seed:dev
 *
 * Refuses to run when NODE_ENV=production or when DATABASE_URL points at a non-local host.
 * The password comes from DEV_SEED_PASSWORD (never committed) and is never printed.
 */
import { pathToFileURL } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { hashPassword } from '../src/auth/password.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { userCredentials, users, type SystemRole } from '../src/db/schema/index.js';

/** Synthetic accounts on the reserved `.example` domain (RFC 2606). */
export const DEV_USERS: ReadonlyArray<{
  email: string;
  givenName: string;
  familyName: string;
  systemRole: SystemRole;
}> = [
  { email: 'admin@academiapath.example', givenName: 'Demo', familyName: 'Administrator', systemRole: 'administrator' },
  { email: 'instructor@academiapath.example', givenName: 'Demo', familyName: 'Instructor', systemRole: 'user' },
  { email: 'student@academiapath.example', givenName: 'Demo', familyName: 'Student', systemRole: 'user' },
  // Course roles (e.g. design team) are assigned per course through enrollments.
  { email: 'reviewer@academiapath.example', givenName: 'Demo', familyName: 'Reviewer', systemRole: 'user' },
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MIN_PASSWORD_LENGTH = 12;

const isLocalHost = (host: string) => LOCAL_HOSTS.has(host) || host.startsWith('/');

/** Throws unless seeding is clearly targeting a local development database. */
export function assertDevSeedAllowed(env: NodeJS.ProcessEnv): { databaseUrl: string; password: string } {
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed development users: NODE_ENV is production.');
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set.');
  }
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid connection URL.');
  }
  // An empty hostname means a Unix socket or PGHOST; a ?host= parameter overrides the hostname.
  const effectiveHost = url.searchParams.get('host') || url.hostname || env.PGHOST || '';
  if (effectiveHost !== '' && !isLocalHost(effectiveHost)) {
    throw new Error(`Refusing to seed development users: database host "${effectiveHost}" is not local.`);
  }
  const password = env.DEV_SEED_PASSWORD;
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`DEV_SEED_PASSWORD must be set (at least ${MIN_PASSWORD_LENGTH} characters).`);
  }
  return { databaseUrl, password };
}

/** Creates or updates the synthetic users and their password credentials. Idempotent. */
export async function seedDevUsers(db: Database, password: string) {
  const seeded: Array<{ email: string; systemRole: SystemRole }> = [];
  for (const devUser of DEV_USERS) {
    const passwordHash = await hashPassword(password);
    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = lower(${devUser.email})`)
        .limit(1);
      const [row] = existing
        ? await tx
            .update(users)
            .set({ givenName: devUser.givenName, familyName: devUser.familyName, systemRole: devUser.systemRole, isActive: true })
            .where(eq(users.id, existing.id))
            .returning({ id: users.id })
        : await tx.insert(users).values(devUser).returning({ id: users.id });
      if (!row) throw new Error(`Could not seed ${devUser.email}`);
      await tx
        .insert(userCredentials)
        .values({ userId: row.id, passwordHash })
        .onConflictDoUpdate({ target: userCredentials.userId, set: { passwordHash, updatedAt: new Date() } });
    });
    seeded.push({ email: devUser.email, systemRole: devUser.systemRole });
  }
  return seeded;
}

async function main() {
  const { databaseUrl, password } = assertDevSeedAllowed(process.env);
  const { db, pool } = createDatabase(databaseUrl);
  try {
    const seeded = await seedDevUsers(db, password);
    console.log('Seeded synthetic development users (password: value of DEV_SEED_PASSWORD):');
    for (const { email, systemRole } of seeded) console.log(`  ${email}  [${systemRole}]`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Seeding failed.');
    process.exitCode = 1;
  });
}
