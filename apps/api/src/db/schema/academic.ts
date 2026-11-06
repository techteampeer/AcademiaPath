import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './columns.js';
import { users } from './users.js';

/** Academic program (e.g. a degree such as Ingeniería de Sistemas). */
export const programs = pgTable(
  'programs',
  {
    id: primaryId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [unique('programs_code_unique').on(t.code)],
);

/**
 * Academic term (Peru-style code such as 2026-1 or 2026-2). The academic year is stored on the term,
 * so the hierarchy is academic year → term; programs and subjects stay reusable across years.
 */
export const terms = pgTable(
  'terms',
  {
    id: primaryId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    academicYear: integer('academic_year').notNull(),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('terms_code_unique').on(t.code),
    check('terms_dates_check', sql`${t.endsOn} >= ${t.startsOn}`),
    check('terms_academic_year_check', sql`${t.academicYear} BETWEEN 2000 AND 2100`),
    index('terms_academic_year_idx').on(t.academicYear),
  ],
);

/**
 * Program-scoped academic management grant: the user may create and version subjects (course
 * templates) of this program. Granted and revoked only by administrators; exercised only while the
 * user is active. It confers no course, grading, user-management or system permission. One grant per
 * user and program (the unique constraint rejects duplicates); revocation deletes the row and the
 * append-only audit log keeps the history.
 */
export const programManagers = pgTable(
  'program_managers',
  {
    id: primaryId(),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    grantedByUserId: uuid('granted_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (t) => [unique('program_managers_program_id_user_id_unique').on(t.programId, t.userId), index('program_managers_user_id_idx').on(t.userId)],
);
