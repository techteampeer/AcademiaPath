import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { generateSessionToken } from '../auth/tokens.js';
import type { Database } from '../db/client.js';
import {
  accountInvitations,
  courses,
  enrollments,
  sessions,
  terms,
  userCredentials,
  users,
} from '../db/schema/index.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Tx;

// ---------------------------------------------------------------------------------------- Emails

const EMAIL_PATTERN = /^[^\s@<>()[\],;:"\\]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Emails are stored trimmed and lowercased, so uniqueness and sign-in are case-insensitive. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Conservative server-side check of a normalized address (no display names, comments or IP literals). */
export function isValidEmail(email: string): boolean {
  if (email.length > 254) return false;
  const at = email.lastIndexOf('@');
  if (at < 1 || at > 64) return false;
  return EMAIL_PATTERN.test(email);
}

const RESERVED_TLDS = new Set(['example', 'test', 'invalid', 'localhost']);
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

/**
 * Synthetic addresses on domains reserved for documentation and testing (RFC 2606, RFC 6761). Local
 * activation links are only ever issued for these, so the local mechanism cannot be used to provision
 * real people.
 */
export function isSyntheticAddress(email: string): boolean {
  const domain = normalizeEmail(email).split('@').pop() ?? '';
  const tld = domain.split('.').pop() ?? '';
  return RESERVED_TLDS.has(tld) || RESERVED_DOMAINS.some((reserved) => domain === reserved || domain.endsWith(`.${reserved}`));
}

/** Rejects control characters in names (they are trimmed and length-checked by the schema). */
export const hasControlCharacters = (value: string) => /[\u0000-\u001f\u007f]/.test(value);

// ---------------------------------------------------------------------------------- Activation links

const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** SHA-256 hex digest stored instead of the token (high-entropy random value, like session tokens). */
export const hashInvitationToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const isWellFormedInvitationToken = (token: string) => INVITATION_TOKEN_PATTERN.test(token);

/** Revokes the user's open (unused, unrevoked) activation links; returns how many. */
export async function revokeOpenInvitations(tx: Executor, userId: string): Promise<number> {
  const rows = await tx
    .update(accountInvitations)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(accountInvitations.userId, userId), isNull(accountInvitations.usedAt), isNull(accountInvitations.revokedAt)))
    .returning({ id: accountInvitations.id });
  return rows.length;
}

/**
 * Issues a new single-use activation link (revoking older open ones). Returns the raw token exactly
 * once; only its hash is stored.
 */
export async function issueInvitation(tx: Tx, options: { userId: string; createdByUserId: string; ttlHours: number }) {
  await revokeOpenInvitations(tx, options.userId);
  const token = generateSessionToken();
  const [row] = await tx
    .insert(accountInvitations)
    .values({
      userId: options.userId,
      tokenHash: hashInvitationToken(token),
      createdByUserId: options.createdByUserId,
      expiresAt: sql`now() + make_interval(hours => ${options.ttlHours})`,
    })
    .returning({ id: accountInvitations.id, expiresAt: accountInvitations.expiresAt });
  if (!row) throw new Error('Invitation was not created');
  return { id: row.id, expiresAt: row.expiresAt, token };
}

export const activationPath = (token: string) => `/activate#token=${token}`;

// -------------------------------------------------------------------------------- Sessions and admins

/** Revokes every unrevoked session of the user; returns how many. */
export async function revokeUserSessions(tx: Executor, userId: string): Promise<number> {
  const rows = await tx
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length;
}

/**
 * Serializes every change that can reduce the number of active administrators (deactivation and
 * demotion), so two concurrent requests can never both remove "the other" last administrator.
 */
export async function lockAdministratorChanges(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('academiapath:active-administrators'))`);
}

export async function countOtherActiveAdministrators(tx: Tx, excludeUserId: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.systemRole, 'administrator'), eq(users.isActive, true), ne(users.id, excludeUserId)));
  return row?.count ?? 0;
}

export async function hasPassword(tx: Executor, userId: string): Promise<boolean> {
  const [row] = await tx.select({ userId: userCredentials.userId }).from(userCredentials).where(eq(userCredentials.userId, userId)).limit(1);
  return row !== undefined;
}

// ---------------------------------------------------------------------------------------- Read models

/**
 * Correlated subqueries use explicit aliases and the fully qualified outer column: Drizzle renders
 * single-table selects without table names, so an unqualified `id` would bind to the inner table.
 */
export const hasCredentialSql = sql`EXISTS (SELECT 1 FROM user_credentials uc WHERE uc.user_id = "users"."id")`;

/** Directory columns (select from `users` only). Never selects credentials or token hashes. */
export const userSummaryColumns = {
  id: users.id,
  email: users.email,
  givenName: users.givenName,
  familyName: users.familyName,
  systemRole: users.systemRole,
  isActive: users.isActive,
  activationState: sql<'activated' | 'pending'>`CASE WHEN ${hasCredentialSql} THEN 'activated' ELSE 'pending' END`,
  activeEnrollmentCount: sql<number>`(SELECT count(*)::int FROM enrollments e WHERE e.user_id = "users"."id" AND e.status = 'active')`,
  courseRoles: sql<string[]>`(SELECT coalesce(array_agg(DISTINCT e.role::text ORDER BY e.role::text), '{}'::text[]) FROM enrollments e WHERE e.user_id = "users"."id" AND e.status = 'active')`,
  createdAt: users.createdAt,
};

/** The full administrator view of one account (or null). */
export async function loadUserDetail(db: Executor, userId: string) {
  const [user] = await db
    .select({ ...userSummaryColumns, institutionalId: users.institutionalId, preferredLocale: users.preferredLocale, updatedAt: users.updatedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;

  const [credential] = await db.select({ createdAt: userCredentials.createdAt }).from(userCredentials).where(eq(userCredentials.userId, userId)).limit(1);
  const [invitation] = await db
    .select({
      id: accountInvitations.id,
      createdAt: accountInvitations.createdAt,
      expiresAt: accountInvitations.expiresAt,
      expired: sql<boolean>`${accountInvitations.expiresAt} <= now()`,
    })
    .from(accountInvitations)
    .where(and(eq(accountInvitations.userId, userId), isNull(accountInvitations.usedAt), isNull(accountInvitations.revokedAt)))
    .orderBy(desc(accountInvitations.createdAt))
    .limit(1);
  const courseEnrollments = await db
    .select({
      id: enrollments.id,
      courseId: courses.id,
      courseCode: courses.code,
      courseTitle: courses.title,
      courseStatus: courses.status,
      termCode: terms.code,
      role: enrollments.role,
      status: enrollments.status,
      createdAt: enrollments.createdAt,
    })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .innerJoin(terms, eq(terms.id, courses.termId))
    .where(eq(enrollments.userId, userId))
    .orderBy(desc(terms.startsOn), asc(courses.code), asc(enrollments.id));

  return {
    ...user,
    activation: {
      state: user.activationState,
      activatedAt: credential?.createdAt ?? null,
      pendingInvitation: credential ? null : (invitation ?? null),
    },
    enrollments: courseEnrollments,
  };
}

export type UserDetail = NonNullable<Awaited<ReturnType<typeof loadUserDetail>>>;
