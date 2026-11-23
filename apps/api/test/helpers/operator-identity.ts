/**
 * AP-OPS-03 (tests only): a trusted operator identity provider for storage recovery tests. Credentials are signed
 * tokens (HMAC-SHA256 over the issuer, audience, subject, roles and expiry) with a random per-test key that callers
 * never see: a token with a changed subject or roles, another key, another issuer or audience, or a past expiry is
 * rejected, and so is any object or plain name passed as a credential. Production has no provider in this build
 * (src/documents/operator-identity.ts); this file is never imported by application code.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { RECOVERY_ROLES, type OperatorIdentityProvider, type RecoveryRole, type VerifiedOperator } from '../../src/documents/operator-identity.js';

const AUDIENCE = 'academiapath-storage-recovery';
const b64 = (value: Buffer | string) => Buffer.from(value).toString('base64url');

export type TestIdentity = {
  provider: OperatorIdentityProvider;
  issuer: string;
  /** The signing key, hex (only for a test child process that must verify the same tokens). */
  keyHex: string;
  issue(subject: string, roles: RecoveryRole[], options?: { ttlSeconds?: number; issuer?: string; audience?: string }): string;
};

export function testOperatorIdentity(options: { keyHex?: string; issuer?: string } = {}): TestIdentity {
  const key = options.keyHex ? Buffer.from(options.keyHex, 'hex') : randomBytes(32);
  const issuer = options.issuer ?? 'academiapath-test-idp';
  const sign = (payload: string) => createHmac('sha256', key).update(payload).digest();
  return {
    issuer,
    keyHex: key.toString('hex'),
    issue(subject, roles, opts = {}) {
      const payload = b64(JSON.stringify({ iss: opts.issuer ?? issuer, aud: opts.audience ?? AUDIENCE, sub: subject, roles, exp: Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? 300) }));
      return `v1.${payload}.${b64(sign(payload))}`;
    },
    provider: {
      async verify(credential: unknown): Promise<VerifiedOperator | null> {
        if (typeof credential !== 'string') return null;
        const [version, payload, signature, ...rest] = credential.split('.');
        if (version !== 'v1' || !payload || !signature || rest.length) return null;
        const expected = sign(payload);
        const given = Buffer.from(signature, 'base64url');
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
        let claims: { iss?: unknown; aud?: unknown; sub?: unknown; roles?: unknown; exp?: unknown };
        try {
          claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        } catch {
          return null;
        }
        if (claims.iss !== issuer || claims.aud !== AUDIENCE || typeof claims.sub !== 'string' || typeof claims.exp !== 'number' || claims.exp <= Date.now() / 1000) return null;
        if (!Array.isArray(claims.roles) || !claims.roles.every((role) => (RECOVERY_ROLES as readonly unknown[]).includes(role))) return null;
        return { issuer, subject: claims.sub, roles: new Set(claims.roles as RecoveryRole[]) };
      },
    },
  };
}
