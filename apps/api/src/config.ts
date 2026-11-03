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
  /** Trust X-Forwarded-* headers. Enable only behind a trusted proxy/load balancer. */
  trustProxy: boolean;
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
    trustProxy: env.TRUST_PROXY === 'true',
  };
}
