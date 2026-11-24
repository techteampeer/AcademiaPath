import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClamdEndpoint } from './documents/clamd.js';
import type { StorageMountCheck } from './documents/readiness.js';
import type { ScanEnforcement } from './documents/scanner.js';
import { validateSignaturePolicy, type SignaturePolicy } from './documents/signature-freshness.js';

export type AppConfig = {
  isProduction: boolean;
  /** Browser origins allowed to make state-changing requests (e.g. the web app). */
  allowedOrigins: string[];
  session: {
    ttlSeconds: number;
    cookieName: string;
    /** Secure cookies are required in production (HTTPS); plain HTTP is allowed for local development. */
    cookieSecure: boolean;
  };
  loginRateLimit: {
    max: number;
    windowMs: number;
  };
  /** Tutor requests allowed per user and course within the window (counted in PostgreSQL). */
  tutorRateLimit: {
    max: number;
    windowMinutes: number;
  };
  /** Messages a person may send within the window, across all conversations (AP-026; counted in PostgreSQL). */
  messageRateLimit: {
    max: number;
    windowMinutes: number;
  };
  /** Forum topics and replies a person may post within the window, across all courses (AP-027; counted in PostgreSQL). */
  forumRateLimit: {
    max: number;
    windowMinutes: number;
  };
  /** How long after posting an author may still edit their own forum topic or reply (AP-027). */
  forumEditWindowMinutes: number;
  /**
   * Fastify `trustProxy`: false, or a comma-separated list of trusted proxy IPs/CIDRs, so
   * X-Forwarded-For is honored only when the connecting peer is a trusted proxy. Never `true`
   * (trusts client-supplied headers) and never a hop count (cannot verify the peer).
   */
  trustProxy: false | string;
  /** Uploaded course documents (local private storage; never a public web directory). */
  documents: {
    /** Absolute directory outside the repository; original files are stored here with opaque names. */
    storageDir: string;
    maxUploadBytes: number;
    /** Hard limit for validating and extracting one document (the worker is terminated after it). */
    extractionTimeoutMs: number;
    /**
     * AP-SEC-05A: the time one document upload may take once its body has arrived (`DOCUMENT_UPLOAD_TIMEOUT_SECONDS`,
     * default 25 s). The web app's proxy gives up on a silent API after `API_PROXY_TIMEOUT_SECONDS` (default 30 s;
     * apps/web/next.config.ts), so this stays at least 5 s below it. Scanning, waiting for an extraction slot and
     * extraction are capped by it; storing starts only while `uploadReserveMs` of it is left, so the API answers
     * (success or a clean refusal) before the proxy times out. See routes/documents.ts.
     */
    uploadTimeoutMs: number;
    /** Kept free in `uploadTimeoutMs` for storing the file and committing the document (4 s; not configurable). */
    uploadReserveMs: number;
    /**
     * A repeated upload of the same file, with the same name and title, by the same user to the same section within this
     * window (10 minutes; not configurable) returns the document already created instead of a duplicate: a retry after a
     * timeout or a lost response. See routes/documents.ts.
     */
    uploadReplayWindowMs: number;
    /**
     * AP-040B storage readiness (`DOCUMENT_STORAGE_MOUNT_CHECK`): `off` (default outside production), `report`
     * (default in production: checked and reported, never blocking) or `enforce` (the storage directory must be a
     * mount point; the API does not start otherwise). See documents/readiness.ts.
     */
    mountCheck: StorageMountCheck;
    /** Create the storage directory on first use (local development and tests only; never in production). */
    createStorageDir: boolean;
  };
  /**
   * AP-038C2E portable course archive import (`ARCHIVE_IMPORT_ENABLED`, default false). Off unless explicitly enabled
   * for local development and tests; refused in production until its production blockers are resolved (see
   * docs/course-package-format.md: orphan-file recovery after a crash, malware scanning, cross-instance limits).
   */
  archiveImport: { enabled: boolean };
  /**
   * AP-040E malware scanning of document uploads and archive imports (docs/malware-scanning.md). Off by default:
   * `MALWARE_SCANNER=none` records documents as `not_scanned`, exactly as before. `clamd` scans every file with a local
   * ClamAV daemon (`CLAMD_SOCKET` or a loopback `CLAMD_ADDRESS`). `MALWARE_SCAN_ENFORCEMENT`: `compatibility` (default)
   * accepts files that could not be verified as `not_scanned`; `strict` refuses them. Infected files are always refused.
   * AP-SEC-05B: `signatures` are the age limits of clamd's loaded signatures (`MALWARE_SIGNATURES_AGING_HOURS`, default
   * 48, and `MALWARE_SIGNATURES_STALE_HOURS`, default 168): a clean answer with stale or unverifiable signatures is not
   * a verdict.
   */
  malwareScanning: {
    scanner: 'none' | 'clamd';
    enforcement: ScanEnforcement;
    clamd: ClamdEndpoint | null;
    timeoutMs: number;
    maxBytes: number;
    maxConcurrent: number;
    signatures: SignaturePolicy;
  };
  /**
   * The institution (AP-025). `timeZone` is the IANA zone used for calendar dates that have none of their
   * own (assignment due dates, all-day defaults); the Peru-based institution defaults to America/Lima.
   */
  institution: {
    timeZone: string;
  };
  /** Administrator-managed accounts. */
  accounts: {
    /**
     * How single-use activation links reach new users. `local_link`: the API returns the link once to
     * the issuing administrator, for synthetic addresses only (local demonstration; refused in production).
     * `disabled`: no links are issued (the production default). `administrator_handoff` (AP-DEMO-02, opt-in,
     * allowed in production): an administrator explicitly issues a link from the user's page after verifying
     * the person's identity, receives it once and hands it over privately; links are never issued
     * automatically and live at most 24 hours.
     */
    invitationDelivery: InvitationDelivery;
    invitationTtlHours: number;
  };
};

export type InvitationDelivery = 'local_link' | 'disabled' | 'administrator_handoff';

/** Longest lifetime of an administrator-handed-over activation link (AP-DEMO-02). */
export const HANDOFF_MAX_TTL_HOURS = 24;

export const SESSION_COOKIE_NAMES = {
  development: 'ap_session',
  // The __Host- prefix makes browsers require Secure, Path=/ and no Domain attribute.
  production: '__Host-ap_session',
} as const;

const DEFAULT_DEV_ORIGIN = 'http://localhost:3000';

/** Repository root (this file lives in apps/api/src or apps/api/dist). */
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function parseMountCheck(raw: string | undefined, isProduction: boolean): StorageMountCheck {
  const value = raw?.trim() || (isProduction ? 'report' : 'off');
  if (value !== 'off' && value !== 'report' && value !== 'enforce') throw new Error('DOCUMENT_STORAGE_MOUNT_CHECK must be off, report or enforce');
  // Production always checks its storage; it may be stricter, never weaker.
  if (isProduction && value === 'off') throw new Error('DOCUMENT_STORAGE_MOUNT_CHECK cannot be off in production');
  return value;
}

function parseArchiveImportEnabled(raw: string | undefined, isProduction: boolean): boolean {
  const value = raw?.trim() || 'false';
  if (value !== 'true' && value !== 'false') throw new Error('ARCHIVE_IMPORT_ENABLED must be true or false');
  if (isProduction && value === 'true') {
    throw new Error('ARCHIVE_IMPORT_ENABLED cannot be true in production yet: archive import is for local development and tests (see docs/course-package-format.md)');
  }
  return value === 'true';
}

const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|::1)$/;

/** `host:port` or `[ipv6]:port`, on this machine only: the clamd protocol has no authentication and no encryption. */
function parseClamdAddress(raw: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(raw);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CLAMD_ADDRESS must be host:port, for example 127.0.0.1:3310');
  if (!LOOPBACK_HOST.test(host)) {
    throw new Error('CLAMD_ADDRESS must be a loopback address (localhost, 127.0.0.1 or [::1]): the clamd protocol is unauthenticated and unencrypted');
  }
  return { host, port };
}

function parseMalwareScanning(env: NodeJS.ProcessEnv, maxUploadBytes: number): AppConfig['malwareScanning'] {
  const scanner = env.MALWARE_SCANNER?.trim() || 'none';
  if (scanner !== 'none' && scanner !== 'clamd') throw new Error('MALWARE_SCANNER must be none or clamd');
  const enforcement = env.MALWARE_SCAN_ENFORCEMENT?.trim() || 'compatibility';
  if (enforcement !== 'compatibility' && enforcement !== 'strict') throw new Error('MALWARE_SCAN_ENFORCEMENT must be compatibility or strict');
  if (enforcement === 'strict' && scanner !== 'clamd') throw new Error('MALWARE_SCAN_ENFORCEMENT=strict needs a scanner (MALWARE_SCANNER=clamd): otherwise every new document would be refused');
  const socket = env.CLAMD_SOCKET?.trim();
  const address = env.CLAMD_ADDRESS?.trim();
  let clamd: ClamdEndpoint | null = null;
  if (scanner === 'clamd') {
    if (Boolean(socket) === Boolean(address)) throw new Error('MALWARE_SCANNER=clamd needs exactly one of CLAMD_SOCKET or CLAMD_ADDRESS');
    if (socket && !isAbsolute(socket)) throw new Error('CLAMD_SOCKET must be an absolute path');
    clamd = socket ? { socketPath: socket } : parseClamdAddress(address!);
  } else if (socket || address) {
    throw new Error('CLAMD_SOCKET and CLAMD_ADDRESS are used only with MALWARE_SCANNER=clamd');
  }
  const maxBytes = readPositiveInt(env, 'MALWARE_SCAN_MAX_MB', 25, 100) * 1024 * 1024;
  // A scanner limit below the upload limit would leave large uploads unscanned (or refused in strict mode).
  if (scanner === 'clamd' && maxBytes < maxUploadBytes) throw new Error('MALWARE_SCAN_MAX_MB must be at least DOCUMENT_MAX_UPLOAD_MB');
  return {
    scanner,
    enforcement,
    clamd,
    timeoutMs: readPositiveInt(env, 'MALWARE_SCAN_TIMEOUT_SECONDS', 30, 300) * 1000,
    maxBytes,
    maxConcurrent: readPositiveInt(env, 'MALWARE_SCAN_CONCURRENCY', 2, 16),
    signatures: parseSignaturePolicy(env, scanner),
  };
}

/**
 * AP-SEC-05B: signatures younger than the aging limit are current; from it they are aging (used, with a warning); from
 * the stale limit no file is verified clean with them. The aging limit must be below the stale limit, which is at most
 * 14 days. Both are refused without a scanner, where they would do nothing.
 */
function parseSignaturePolicy(env: NodeJS.ProcessEnv, scanner: 'none' | 'clamd'): SignaturePolicy {
  const names = ['MALWARE_SIGNATURES_AGING_HOURS', 'MALWARE_SIGNATURES_STALE_HOURS'] as const;
  if (scanner !== 'clamd' && names.some((name) => env[name]?.trim())) throw new Error('MALWARE_SIGNATURES_AGING_HOURS and MALWARE_SIGNATURES_STALE_HOURS are used only with MALWARE_SCANNER=clamd');
  const agingHours = readPositiveInt(env, names[0], 48, 335);
  const staleHours = readPositiveInt(env, names[1], 168, 336);
  if (agingHours >= staleHours) throw new Error('MALWARE_SIGNATURES_AGING_HOURS must be below MALWARE_SIGNATURES_STALE_HOURS');
  return validateSignaturePolicy({ agingAfterMs: agingHours * 3_600_000, staleAfterMs: staleHours * 3_600_000 });
}

/** Kept free for storing the file and committing the document once processing ends (AP-SEC-05A). */
const UPLOAD_RESERVE_MS = 4_000;
/** How long a repeated identical upload returns the document already created (AP-SEC-05A). */
const UPLOAD_REPLAY_WINDOW_MS = 10 * 60_000;

/**
 * AP-SEC-05A: the upload budget must hold every stage that can run in it, one after the other: the scan (when a scanner
 * is configured), extraction, and the time reserved for storing. Otherwise uploads could only end in timeouts; the API
 * refuses to start instead. Raising it also needs the web proxy's API_PROXY_TIMEOUT_SECONDS raised (5 s above it).
 */
function parseUploadTimeout(env: NodeJS.ProcessEnv, extractionTimeoutMs: number, scanning: AppConfig['malwareScanning']): number {
  const uploadTimeoutMs = readPositiveInt(env, 'DOCUMENT_UPLOAD_TIMEOUT_SECONDS', 25, 270) * 1000;
  if (uploadTimeoutMs < 5_000) throw new Error('DOCUMENT_UPLOAD_TIMEOUT_SECONDS must be at least 5');
  const scanMs = scanning.scanner === 'clamd' ? scanning.timeoutMs : 0;
  const neededMs = scanMs + extractionTimeoutMs + UPLOAD_RESERVE_MS;
  if (neededMs > uploadTimeoutMs) {
    const parts = [scanMs ? `MALWARE_SCAN_TIMEOUT_SECONDS (${scanMs / 1000})` : null, `DOCUMENT_EXTRACTION_TIMEOUT_SECONDS (${extractionTimeoutMs / 1000})`, `${UPLOAD_RESERVE_MS / 1000} s for storing`].filter(Boolean);
    throw new Error(
      `DOCUMENT_UPLOAD_TIMEOUT_SECONDS (${uploadTimeoutMs / 1000}) must be at least ${parts.join(' + ')} = ${neededMs / 1000}; raise it together with the web proxy's API_PROXY_TIMEOUT_SECONDS (at least 5 s more)`,
    );
  }
  return uploadTimeoutMs;
}

function parseStorageDir(raw: string | undefined, isProduction: boolean): string {
  const value = raw?.trim();
  if (!value && isProduction) throw new Error('DOCUMENT_STORAGE_DIR must be set in production');
  const dir = value || resolve(homedir(), '.academiapath', 'documents');
  if (!isAbsolute(dir)) throw new Error('DOCUMENT_STORAGE_DIR must be an absolute path');
  const resolved = resolve(dir);
  const fromRepo = relative(REPOSITORY_ROOT, resolved);
  if (fromRepo === '' || (!fromRepo.startsWith('..') && !isAbsolute(fromRepo))) {
    // Keeps uploads out of the repository and therefore out of every public web directory.
    throw new Error('DOCUMENT_STORAGE_DIR must be outside the repository');
  }
  return resolved;
}

function readPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function parseOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        throw new Error(`APP_ORIGINS contains an invalid origin: ${value}`);
      }
    });
}

function parseInvitationDelivery(raw: string | undefined, isProduction: boolean): InvitationDelivery {
  const value = raw?.trim() || (isProduction ? 'disabled' : 'local_link');
  if (value !== 'local_link' && value !== 'disabled' && value !== 'administrator_handoff') {
    throw new Error('ACCOUNT_INVITATION_DELIVERY must be local_link, disabled or administrator_handoff');
  }
  if (isProduction && value === 'local_link') {
    throw new Error(
      'ACCOUNT_INVITATION_DELIVERY=local_link is for synthetic local demonstration only; production requires a secure delivery and identity-verification mechanism',
    );
  }
  return value;
}

function parseTrustProxy(raw: string | undefined): false | string {
  const value = raw?.trim();
  if (!value || value === 'false') return false;
  if (value === 'true') {
    throw new Error(
      'TRUST_PROXY=true would trust client-supplied X-Forwarded-For headers; list the trusted proxy IPs/CIDRs instead',
    );
  }
  if (/^\d+$/.test(value)) {
    throw new Error('TRUST_PROXY hop counts are not supported (the connecting peer cannot be verified); list the trusted proxy IPs/CIDRs instead');
  }
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    const [address = '', prefix] = entry.split('/');
    const maxPrefix = isIP(address) === 6 ? 128 : 32;
    if (!isIP(address) || (prefix !== undefined && !(/^\d{1,3}$/.test(prefix) && Number(prefix) <= maxPrefix))) {
      throw new Error(`TRUST_PROXY contains an invalid IP or CIDR: ${entry}`);
    }
  }
  return entries.join(',');
}

/** Builds the application configuration from environment variables. Fails fast on invalid values. */
/** A valid IANA time zone (default America/Lima); invalid values fail at startup instead of at render time. */
export const DEFAULT_TIME_ZONE = 'America/Lima';
export function isValidTimeZone(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
function parseTimeZone(value: string | undefined): string {
  const zone = value?.trim() || DEFAULT_TIME_ZONE;
  if (!isValidTimeZone(zone)) throw new Error(`INSTITUTION_TIME_ZONE is not a valid IANA time zone: ${zone}`);
  return zone;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isProduction = env.NODE_ENV === 'production';

  const originsRaw = env.APP_ORIGINS?.trim();
  if (isProduction && !originsRaw) {
    throw new Error('APP_ORIGINS must be set in production');
  }
  const allowedOrigins = parseOrigins(originsRaw || DEFAULT_DEV_ORIGIN);
  const invitationDelivery = parseInvitationDelivery(env.ACCOUNT_INVITATION_DELIVERY, isProduction);
  const maxUploadBytes = readPositiveInt(env, 'DOCUMENT_MAX_UPLOAD_MB', 10, 100) * 1024 * 1024;
  const extractionTimeoutMs = readPositiveInt(env, 'DOCUMENT_EXTRACTION_TIMEOUT_SECONDS', 20, 300) * 1000;
  const malwareScanning = parseMalwareScanning(env, maxUploadBytes);
  const uploadTimeoutMs = parseUploadTimeout(env, extractionTimeoutMs, malwareScanning);

  return {
    isProduction,
    allowedOrigins,
    session: {
      ttlSeconds: readPositiveInt(env, 'SESSION_TTL_HOURS', 8, 24 * 30) * 3600,
      cookieName: isProduction ? SESSION_COOKIE_NAMES.production : SESSION_COOKIE_NAMES.development,
      cookieSecure: isProduction,
    },
    loginRateLimit: {
      max: readPositiveInt(env, 'LOGIN_RATE_LIMIT_MAX', 5, 1000),
      windowMs: readPositiveInt(env, 'LOGIN_RATE_LIMIT_WINDOW_MINUTES', 15, 24 * 60) * 60_000,
    },
    tutorRateLimit: {
      max: readPositiveInt(env, 'TUTOR_RATE_LIMIT_MAX', 20, 1000),
      windowMinutes: readPositiveInt(env, 'TUTOR_RATE_LIMIT_WINDOW_MINUTES', 10, 24 * 60),
    },
    messageRateLimit: {
      max: readPositiveInt(env, 'MESSAGE_RATE_LIMIT_MAX', 30, 1000),
      windowMinutes: readPositiveInt(env, 'MESSAGE_RATE_LIMIT_WINDOW_MINUTES', 5, 24 * 60),
    },
    forumRateLimit: {
      max: readPositiveInt(env, 'FORUM_POST_RATE_LIMIT_MAX', 10, 1000),
      windowMinutes: readPositiveInt(env, 'FORUM_POST_RATE_LIMIT_WINDOW_MINUTES', 5, 24 * 60),
    },
    forumEditWindowMinutes: readPositiveInt(env, 'FORUM_EDIT_WINDOW_MINUTES', 30, 7 * 24 * 60),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    documents: {
      storageDir: parseStorageDir(env.DOCUMENT_STORAGE_DIR, isProduction),
      maxUploadBytes,
      extractionTimeoutMs,
      uploadTimeoutMs,
      uploadReserveMs: UPLOAD_RESERVE_MS,
      uploadReplayWindowMs: UPLOAD_REPLAY_WINDOW_MS,
      mountCheck: parseMountCheck(env.DOCUMENT_STORAGE_MOUNT_CHECK, isProduction),
      createStorageDir: !isProduction,
    },
    archiveImport: { enabled: parseArchiveImportEnabled(env.ARCHIVE_IMPORT_ENABLED, isProduction) },
    malwareScanning,
    institution: {
      timeZone: parseTimeZone(env.INSTITUTION_TIME_ZONE),
    },
    accounts: {
      invitationDelivery,
      invitationTtlHours:
        invitationDelivery === 'administrator_handoff'
          ? readPositiveInt(env, 'ACCOUNT_INVITATION_TTL_HOURS', HANDOFF_MAX_TTL_HOURS, HANDOFF_MAX_TTL_HOURS)
          : readPositiveInt(env, 'ACCOUNT_INVITATION_TTL_HOURS', 72, 24 * 7),
    },
  };
}
