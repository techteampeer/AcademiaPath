import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sessions, userCredentials, users } from '../db/schema/index.js';
import { generateSessionToken, hashSessionToken } from './tokens.js';
import type { SafeUser } from './types.js';

/** Column selection for safe user profile fields; never includes credentials. */
export const safeUserColumns = {
  id: users.id,
  email: users.email,
  givenName: users.givenName,
  familyName: users.familyName,
  systemRole: users.systemRole,
  preferredLocale: users.preferredLocale,
};

type DbExecutor = Pick<Database, 'select' | 'insert' | 'update'>;

export type LoginAccount = { user: SafeUser; isActive: boolean; passwordHash: string };

/** Case-insensitive lookup of a user with a password credential. */
export async function findLoginAccount(db: DbExecutor, email: string): Promise<LoginAccount | null> {
  const rows = await db
    .select({ user: safeUserColumns, isActive: users.isActive, passwordHash: userCredentials.passwordHash })
    .from(users)
    .innerJoin(userCredentials, eq(userCredentials.userId, users.id))
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  return rows[0] ?? null;
}

/** Creates a session and returns the raw token, which is only ever sent in the cookie. */
export async function createSession(db: DbExecutor, userId: string, ttlSeconds: number) {
  const token = generateSessionToken();
  const rows = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashSessionToken(token),
      // Database clock for both creation and validation.
      expiresAt: sql`now() + make_interval(secs => ${ttlSeconds})`,
    })
    .returning({ id: sessions.id, expiresAt: sessions.expiresAt });
  const row = rows[0];
  if (!row) throw new Error('Session was not created');
  return { token, sessionId: row.id, expiresAt: row.expiresAt };
}

/** Returns the session and user only if the session is unrevoked, unexpired and the user is active. */
export async function findActiveSession(db: DbExecutor, token: string) {
  const rows = await db
    .select({ sessionId: sessions.id, expiresAt: sessions.expiresAt, user: safeUserColumns })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashSessionToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, sql`now()`),
        eq(users.isActive, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function revokeSession(db: DbExecutor, sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

export async function revokeSessionByToken(db: DbExecutor, token: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(sessions.tokenHash, hashSessionToken(token)), isNull(sessions.revokedAt)));
}
