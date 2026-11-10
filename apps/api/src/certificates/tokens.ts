import { randomBytes, randomInt } from 'node:crypto';

/** 256-bit random, URL-safe verification token (43 base64url characters). Never derived from an id. */
export function newVerificationToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Strict shape check before any lookup: anything else is answered like an unknown token. */
export const VERIFICATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// No 0/O or 1/I, so a printed number can be read back without ambiguity.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

/** Random, non-sequential certificate number printed on the certificate, e.g. AP-7K3M-Q9TX-2HDP. */
export function newCertificateNumber(): string {
  return `AP-${group()}-${group()}-${group()}`;
}
