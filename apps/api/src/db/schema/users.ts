import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './columns.js';
import { localeEnum, systemRoleEnum } from './enums.js';

export const users = pgTable(
  'users',
  {
    id: primaryId(),
    email: text('email').notNull(),
    givenName: text('given_name').notNull(),
    familyName: text('family_name').notNull(),
    /** University-issued student or staff code (optional, unique when present). */
    institutionalId: text('institutional_id'),
    systemRole: systemRoleEnum('system_role').notNull().default('user'),
    preferredLocale: localeEnum('preferred_locale').notNull().default('es'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('users_email_lower_unique').on(sql`lower(${t.email})`),
    unique('users_institutional_id_unique').on(t.institutionalId),
  ],
);
