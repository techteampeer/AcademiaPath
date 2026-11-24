/**
 * AP-SEC-05B: how old the malware signatures loaded in the scanner may be (docs/malware-scanning.md).
 *
 * The only accepted source is the scanner's own report of the signature database it has loaded (for clamd, the daily
 * database's build time in its `VERSION` answer). Engine versions, image build times, container start times and
 * configuration claims are not evidence of fresh signatures, and a scanner that answers but cannot say when its
 * signatures were built is `unknown`, which is never a trusted verdict.
 *
 * All times are UTC epoch milliseconds from the API server's clock (the trusted clock; tests control it).
 */

export type SignaturePolicy = {
  /** Signatures at least this old are `aging`: still used, with a warning (default 48 hours). */
  agingAfterMs: number;
  /** Signatures at least this old are `stale`: no file is verified clean with them (default 7 days). */
  staleAfterMs: number;
};

const HOUR_MS = 60 * 60_000;
export const DEFAULT_SIGNATURE_POLICY: SignaturePolicy = { agingAfterMs: 48 * HOUR_MS, staleAfterMs: 7 * 24 * HOUR_MS };
/** The longest `stale` limit the configuration accepts (14 days): ClamAV itself warns after 7 days. */
export const MAX_SIGNATURE_AGE_MS = 14 * 24 * HOUR_MS;
/**
 * A signature build time ahead of the API server's clock by at most this much is clock skew and counts as just built;
 * further ahead, the time cannot be trusted and the signatures are `unknown`.
 */
export const SIGNATURE_CLOCK_SKEW_MS = 5 * 60_000;
/**
 * How long one successful observation of the loaded signatures is reused before the scanner is asked again. The state
 * is recomputed from the build time on every use, so a reused observation still ages; this only bounds how long a
 * scanner restart with other signatures can go unnoticed.
 */
export const SIGNATURE_CHECK_TTL_MS = 60_000;

/** What the scanner reported about its loaded signatures. */
export type SignatureObservation = { engine: string; databaseVersion: number; databaseTime: number };

/**
 * Why the age of the loaded signatures is not known:
 * - `unreachable`, `timeout`, `interrupted`: the scanner could not be asked, or did not answer in time or completely;
 * - `version_unavailable`: the scanner refuses the command that reports its signatures (clamd `EnableVersionCommand no`);
 * - `no_signature_date`: the scanner answered without a signature build time (for example no daily database loaded);
 * - `unsupported_response`: an answer in a form this code does not know, or with an impossible date;
 * - `future_timestamp`: a build time further in the future than the allowed clock skew.
 */
export type SignatureUnknownReason = 'unreachable' | 'timeout' | 'interrupted' | 'version_unavailable' | 'no_signature_date' | 'unsupported_response' | 'future_timestamp';

export type SignatureFreshness =
  | { state: 'current' | 'aging' | 'stale'; ageMs: number; databaseVersion: number; databaseTime: number }
  | { state: 'unknown'; reason: SignatureUnknownReason };

/** Throws unless 0 < aging < stale <= MAX_SIGNATURE_AGE_MS (checked when the configuration is loaded). */
export function validateSignaturePolicy(policy: SignaturePolicy): SignaturePolicy {
  const { agingAfterMs, staleAfterMs } = policy;
  if (!Number.isInteger(agingAfterMs) || !Number.isInteger(staleAfterMs) || agingAfterMs <= 0 || staleAfterMs <= agingAfterMs || staleAfterMs > MAX_SIGNATURE_AGE_MS) {
    throw new Error('Invalid malware signature age limits: the aging limit must be positive and below the stale limit, which can be at most 14 days');
  }
  return policy;
}

/** The state of the observed signatures at `nowMs`: current below the aging limit, aging below the stale limit. */
export function assessSignatures(observation: SignatureObservation, nowMs: number, policy: SignaturePolicy): SignatureFreshness {
  const age = nowMs - observation.databaseTime;
  if (!Number.isFinite(age) || age < -SIGNATURE_CLOCK_SKEW_MS) return { state: 'unknown', reason: 'future_timestamp' };
  const ageMs = Math.max(0, age);
  const state = ageMs >= policy.staleAfterMs ? 'stale' : ageMs >= policy.agingAfterMs ? 'aging' : 'current';
  return { state, ageMs, databaseVersion: observation.databaseVersion, databaseTime: observation.databaseTime };
}

/** A short, log-friendly description (never connection details). */
export function describeSignatures(freshness: SignatureFreshness) {
  return freshness.state === 'unknown'
    ? { state: freshness.state, reason: freshness.reason }
    : {
        state: freshness.state,
        ageHours: Math.floor(freshness.ageMs / 360_000) / 10,
        databaseVersion: freshness.databaseVersion,
        builtAt: new Date(freshness.databaseTime).toISOString(),
      };
}
