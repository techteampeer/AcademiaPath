import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
     * the issuing administrator, for synthetic addresses only (local demonstration). `disabled`: no
     * links are issued. Production allows only `disabled` until secure delivery and identity
     * verification are configured.
     */
    invitationDelivery: InvitationDelivery;
    invitationTtlHours: number;
  };
};

export type InvitationDelivery = 'local_link' | 'disabled';

export const SESSION_COOKIE_NAMES = {
  development: 'ap_session',
  // The __Host- prefix makes browsers require Secure, Path=/ and no Domain attribute.
  production: '__Host-ap_session',
} as const;

const DEFAULT_DEV_ORIGIN = 'http://localhost:3000';

/** Repository root (this file lives in apps/api/src or apps/api/dist). */
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

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
  if (value !== 'local_link' && value !== 'disabled') {
    throw new Error('ACCOUNT_INVITATION_DELIVERY must be local_link or disabled');
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
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    documents: {
      storageDir: parseStorageDir(env.DOCUMENT_STORAGE_DIR, isProduction),
      maxUploadBytes: readPositiveInt(env, 'DOCUMENT_MAX_UPLOAD_MB', 10, 100) * 1024 * 1024,
      extractionTimeoutMs: readPositiveInt(env, 'DOCUMENT_EXTRACTION_TIMEOUT_SECONDS', 20, 300) * 1000,
    },
    institution: {
      timeZone: parseTimeZone(env.INSTITUTION_TIME_ZONE),
    },
    accounts: {
      invitationDelivery: parseInvitationDelivery(env.ACCOUNT_INVITATION_DELIVERY, isProduction),
      invitationTtlHours: readPositiveInt(env, 'ACCOUNT_INVITATION_TTL_HOURS', 72, 24 * 7),
    },
  };
}
