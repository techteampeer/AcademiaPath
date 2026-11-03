import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './columns.js';
import { users } from './users.js';

/**
 * Password credential, kept out of `users` so user queries can never return a hash.
 * Only Argon2id PHC strings are accepted, so plaintext can never be stored.
 */
export const userCredentials = pgTable(
  'user_credentials',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    passwordHash: text('password_hash').notNull(),
    ...timestamps(),
  },
  (t) => [check('user_credentials_password_hash_argon2id_check', sql`${t.passwordHash} LIKE '$argon2id$%'`)],
);

/**
 * Server-side session. Only the SHA-256 hex digest of the session token is stored;
 * the token itself exists only in the client's HttpOnly cookie.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set on logout or replacement; revoked sessions are never valid again. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('sessions_token_hash_unique').on(t.tokenHash),
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
    check('sessions_token_hash_format_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('sessions_expiry_check', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);
