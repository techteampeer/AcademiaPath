import { sql } from 'drizzle-orm';
import { boolean, check, date, pgTable, text, unique } from 'drizzle-orm/pg-core';
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

/** Academic term (e.g. 2026-II). */
export const terms = pgTable(
  'terms',
  {
    id: primaryId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('terms_code_unique').on(t.code),
    check('terms_dates_check', sql`${t.endsOn} >= ${t.startsOn}`),
  ],
);
