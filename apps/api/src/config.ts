import { isIP } from 'node:net';

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
  /**
   * Fastify `trustProxy`: false, or a comma-separated list of trusted proxy IPs/CIDRs, so
   * X-Forwarded-For is honored only when the connecting peer is a trusted proxy. Never `true`
   * (trusts client-supplied headers) and never a hop count (cannot verify the peer).
   */
  trustProxy: false | string;
};

export const SESSION_COOKIE_NAMES = {
  development: 'ap_session',
  // The __Host- prefix makes browsers require Secure, Path=/ and no Domain attribute.
  production: '__Host-ap_session',
} as const;

const DEFAULT_DEV_ORIGIN = 'http://localhost:3000';

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
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}
