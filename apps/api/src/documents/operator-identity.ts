/**
 * AP-OPS-03: who may plan, approve and execute storage recovery. Every recovery lifecycle function takes an opaque
 * credential and asks a trusted identity provider to verify it; the verified issuer and subject are what plans,
 * approvals, revocations and execution claims record. No function accepts an operator name, flag or environment
 * variable as an identity, and there is no fallback when verification fails.
 *
 * NO PRODUCTION PROVIDER EXISTS IN THIS BUILD. `NO_TRUSTED_OPERATOR_IDENTITY` rejects every credential, so outside the
 * tests (which inject a signed-token provider, test/helpers/operator-identity.ts) no plan can be created, approved or
 * executed. Connecting verified Google Cloud identities is a separate, approved milestone
 * (docs/production-storage-recovery.md).
 */

/** Separate duties: planners propose, approvers authorize (never their own plans), executors run approved plans. */
export const RECOVERY_ROLES = ['storage_recovery.planner', 'storage_recovery.approver', 'storage_recovery.executor'] as const;
export type RecoveryRole = (typeof RECOVERY_ROLES)[number];

/** An identity established by the provider, never by the caller. */
export type VerifiedOperator = { readonly issuer: string; readonly subject: string; readonly roles: ReadonlySet<RecoveryRole> };

export interface OperatorIdentityProvider {
  /** Verifies an opaque credential: the operator it proves, or null. Must not trust anything the caller asserts. */
  verify(credential: unknown): Promise<VerifiedOperator | null>;
}

/** The only provider this build ships: nothing is trusted. */
export const NO_TRUSTED_OPERATOR_IDENTITY: OperatorIdentityProvider = { verify: async () => null };

const PRINCIPAL = /^[\x21-\x7e]{1,200}$/;

/** Asks the provider, and accepts only a well-formed answer; any error or malformed answer is a rejection. */
export async function verifyOperator(provider: OperatorIdentityProvider, credential: unknown): Promise<VerifiedOperator | null> {
  let operator: VerifiedOperator | null;
  try {
    operator = await provider.verify(credential);
  } catch {
    return null;
  }
  if (!operator || typeof operator.issuer !== 'string' || typeof operator.subject !== 'string') return null;
  if (!PRINCIPAL.test(operator.issuer) || !PRINCIPAL.test(operator.subject) || !(operator.roles instanceof Set)) return null;
  const roles = new Set<RecoveryRole>();
  for (const role of operator.roles) if ((RECOVERY_ROLES as readonly string[]).includes(role)) roles.add(role);
  return Object.freeze({ issuer: operator.issuer, subject: operator.subject, roles });
}

export const sameOperator = (a: { issuer: string; subject: string }, b: { issuer: string | null; subject: string | null }) => a.issuer === b.issuer && a.subject === b.subject;
