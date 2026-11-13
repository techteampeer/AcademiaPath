/**
 * Course e-mail recipients (AP-044): the BCC list for one e-mail that a course instructor composes and sends from
 * their own e-mail application. AcademiaPath never sends, queues or tracks that e-mail. Only active students with
 * active accounts are listed; addresses that are not valid e-mail addresses, and repeated addresses, are left out.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { enrollments, users } from '../db/schema/index.js';
import { isValidEmail, normalizeEmail } from '../users/accounts.js';

export type RecipientRow = { email: string | null; givenName: string; familyName: string };
export type EmailRecipient = { name: string; email: string };
export type EmailRecipientList = { recipients: EmailRecipient[]; excluded: { invalidEmail: number; duplicateEmail: number } };

/**
 * Keeps one entry per address (compared without case or surrounding spaces) and only valid addresses. An address is
 * kept as stored (trimmed); its validity is checked like the account form does.
 */
export function emailRecipientList(rows: readonly RecipientRow[]): EmailRecipientList {
  const seen = new Set<string>();
  const recipients: EmailRecipient[] = [];
  let invalidEmail = 0;
  let duplicateEmail = 0;
  for (const row of rows) {
    const email = (row.email ?? '').trim();
    const key = normalizeEmail(email);
    if (!isValidEmail(key)) invalidEmail += 1;
    else if (seen.has(key)) duplicateEmail += 1;
    else {
      seen.add(key);
      recipients.push({ name: `${row.givenName} ${row.familyName}`.trim(), email });
    }
  }
  return { recipients, excluded: { invalidEmail, duplicateEmail } };
}

/** The course's students with an active enrollment and an active account (the rule used for course messaging). */
export async function loadEmailRecipients(db: Pick<Database, 'select'>, courseId: string): Promise<EmailRecipientList> {
  const rows = await db
    .select({ email: users.email, givenName: users.givenName, familyName: users.familyName })
    .from(enrollments)
    .innerJoin(users, eq(users.id, enrollments.userId))
    .where(and(eq(enrollments.courseId, courseId), eq(enrollments.role, 'student'), eq(enrollments.status, 'active'), eq(users.isActive, true)))
    .orderBy(asc(users.familyName), asc(users.givenName), asc(users.email));
  return emailRecipientList(rows);
}
