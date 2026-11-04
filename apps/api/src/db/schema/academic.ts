import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './columns.js';

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
