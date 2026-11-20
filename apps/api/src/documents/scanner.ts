import type { DocumentFormat } from '../db/schema/index.js';

/**
 * Why a scan did not produce a verdict (AP-040E). Never a message, a path or file content.
 * - `connect_failed`: the scanner could not be reached (unavailable).
 * - `deadline`: no verdict within the time limit, including time spent waiting for a scan slot (timeout).
 * - `interrupted`: the connection ended before a complete verdict arrived.
 * - `invalid_response`: the scanner answered something that is not a known verdict.
 * - `scanner_error`: the scanner reported an error of its own.
 * - `file_too_large`: the file is larger than the scanner accepts, so it was not (fully) scanned.
 * - `limits_exceeded`: the scanner stopped at one of its own scan limits (for example nesting depth), so the
 *   file was not fully scanned.
 */
export type ScanFailureReason = 'connect_failed' | 'deadline' | 'interrupted' | 'invalid_response' | 'scanner_error' | 'file_too_large' | 'limits_exceeded';

/**
 * The outcome of one scan. Only `clean` means a scanning engine examined the whole file and found nothing;
 * `not_scanned` means no scanner is connected. `unavailable`, `timeout` and `error` are failures: no verdict.
 */
export type MalwareScanResult =
  | { status: 'not_scanned'; scanner: string }
  | { status: 'clean'; scanner: string }
  | { status: 'infected'; scanner: string; signature?: string }
  | { status: 'unavailable' | 'timeout' | 'error'; scanner: string; reason: ScanFailureReason };

/**
 * Malware scanning, called for every document upload and every document of an archive import, with the complete
 * file, before the file is parsed or stored. Implementations return failures as results (never as a clean verdict);
 * an implementation that throws is a defect, and the upload or import then fails without storing anything.
 */
export interface MalwareScanner {
  scan(bytes: Uint8Array, file: { fileName: string; format: DocumentFormat }): Promise<MalwareScanResult>;
}

/**
 * Default: NO malware scanning service is connected. Uploads are recorded as `not_scanned`. This proof of concept is
 * not approved for untrusted production documents (see docs/malware-scanning.md).
 */
export const noMalwareScanner: MalwareScanner = {
  async scan() {
    return { status: 'not_scanned', scanner: 'none' };
  },
};

/**
 * What to do when a file could not be verified (`MALWARE_SCAN_ENFORCEMENT`):
 * - `compatibility` (default): accept it as `not_scanned`, exactly as without a scanner. Never reported as clean.
 * - `strict`: refuse it. Only files with a verified clean result are accepted.
 * Infected files are rejected in both modes.
 */
export type ScanEnforcement = 'compatibility' | 'strict';

/** The policy's decision for one scanned file. `status` and `scanner` are what the document record keeps. */
export type ScanDecision =
  | { action: 'accept'; status: 'clean' | 'not_scanned'; scanner: string }
  | { action: 'reject_infected'; scanner: string; signature: string | null }
  | { action: 'refuse_unverified'; scanner: string; status: string; reason: ScanFailureReason | 'not_scanned' };

/** The single place that turns a scan result into accept or refuse, for uploads and archive imports alike. */
export function decideScan(result: MalwareScanResult, enforcement: ScanEnforcement): ScanDecision {
  switch (result.status) {
    case 'clean':
      return { action: 'accept', status: 'clean', scanner: result.scanner };
    case 'infected':
      return { action: 'reject_infected', scanner: result.scanner, signature: result.signature ?? null };
    case 'not_scanned':
      return enforcement === 'strict'
        ? { action: 'refuse_unverified', scanner: result.scanner, status: 'not_scanned', reason: 'not_scanned' }
        : { action: 'accept', status: 'not_scanned', scanner: result.scanner };
    case 'unavailable':
    case 'timeout':
    case 'error':
      // Recorded as `<scanner>:<outcome>` (for example `clamd:timeout`) so staff can see that a scan was attempted.
      return enforcement === 'strict'
        ? { action: 'refuse_unverified', scanner: result.scanner, status: result.status, reason: result.reason }
        : { action: 'accept', status: 'not_scanned', scanner: `${result.scanner}:${result.status}` };
    default: {
      // A result this code does not know is never a verdict.
      const unknown = result as { scanner?: unknown };
      const scanner = typeof unknown.scanner === 'string' ? unknown.scanner : 'unknown';
      return enforcement === 'strict'
        ? { action: 'refuse_unverified', scanner, status: 'error', reason: 'invalid_response' }
        : { action: 'accept', status: 'not_scanned', scanner: `${scanner}:error` };
    }
  }
}
