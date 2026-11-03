import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CSRF_CONTEXT = 'academiapath:csrf:v1';

/** 256-bit cryptographically random token, base64url encoded (43 characters). */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/** Cheap shape check so malformed cookies are rejected without a database lookup. */
export function isWellFormedSessionToken(value: string): boolean {
  return SESSION_TOKEN_PATTERN.test(value);
}

/**
 * SHA-256 hex digest stored instead of the token. A fast hash is appropriate because the
 * token is high-entropy random data, not a user-chosen secret.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * CSRF token bound to the session: HMAC keyed by the secret session token, so it cannot be
 * computed without the HttpOnly cookie and is never stored.
 */
export function deriveCsrfToken(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update(CSRF_CONTEXT).digest('base64url');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
