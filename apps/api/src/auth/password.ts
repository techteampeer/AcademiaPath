import { randomBytes } from 'node:crypto';
import { hash, verify, type Algorithm } from '@node-rs/argon2';

/** Argon2id with OWASP-recommended minimum parameters (19 MiB memory, 2 iterations, 1 lane). */
export const PASSWORD_HASH_OPTIONS = {
  // `Algorithm` is an ambient const enum (not importable as a value); 2 is Algorithm.Argon2id.
  algorithm: 2 as Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, PASSWORD_HASH_OPTIONS);
}

/** Returns false for any mismatch or malformed hash; never throws for bad input. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Hash of a random value, verified against when an account does not exist so that
 * unknown emails take about as long as wrong passwords (reduces user enumeration by timing).
 */
export function getDummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummyHash;
}
