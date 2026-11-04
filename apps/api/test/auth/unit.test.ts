import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { assertDevSeedAllowed } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/db/client.js';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';
import {
  deriveCsrfToken,
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
  safeEqual,
} from '../../src/auth/tokens.js';
import { loadConfig } from '../../src/config.js';

describe('session and CSRF tokens', () => {
  it('generates unique 256-bit base64url session tokens', () => {
    const tokens = new Set(Array.from({ length: 100 }, generateSessionToken));
    assert.equal(tokens.size, 100);
    for (const token of tokens) {
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(token, 'base64url').length, 32);
    }
  });

  it('stores SHA-256 digests, never the token', () => {
    const token = generateSessionToken();
    const digest = hashSessionToken(token);
    assert.equal(digest, createHash('sha256').update(token).digest('hex'));
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.notEqual(digest, token);
  });

  it('derives a deterministic, session-bound CSRF token', () => {
    const token = generateSessionToken();
    const csrf = deriveCsrfToken(token);
    assert.equal(deriveCsrfToken(token), csrf);
    assert.notEqual(deriveCsrfToken(generateSessionToken()), csrf);
    assert.notEqual(csrf, token);
    assert.ok(safeEqual(csrf, deriveCsrfToken(token)));
    assert.ok(!safeEqual(csrf, `${csrf}x`));
  });

  it('rejects malformed session cookie values before any lookup', () => {
    for (const value of ['', 'short', `${generateSessionToken()}x`, `${generateSessionToken().slice(1)}=`, 'a'.repeat(42) + '!']) {
      assert.equal(isWellFormedSessionToken(value), false, value);
    }
    assert.equal(isWellFormedSessionToken(generateSessionToken()), true);
  });
});

describe('password hashing', () => {
  it('uses Argon2id with OWASP minimum parameters and a random salt', async () => {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');
    assert.match(first, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    assert.notEqual(first, second);
  });

  it('verifies correct passwords and rejects wrong or malformed input', async () => {
    const passwordHash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword(passwordHash, 'correct horse battery staple'), true);
    assert.equal(await verifyPassword(passwordHash, 'Correct horse battery staple'), false);
    assert.equal(await verifyPassword('not-a-hash', 'anything'), false);
  });
});

describe('configuration', () => {
  it('uses a non-Secure ap_session cookie and the local web origin in development', () => {
    const config = loadConfig({});
    assert.equal(config.isProduction, false);
    assert.equal(config.session.cookieName, 'ap_session');
    assert.equal(config.session.cookieSecure, false);
    assert.equal(config.session.ttlSeconds, 8 * 3600);
    assert.deepEqual(config.allowedOrigins, ['http://localhost:3000']);
    assert.deepEqual(config.loginRateLimit, { max: 5, windowMs: 15 * 60_000 });
    assert.equal(config.trustProxy, false);
  });

  it('requires explicit origins and a Secure __Host- cookie in production', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /APP_ORIGINS/);
    const config = loadConfig({
      NODE_ENV: 'production',
      APP_ORIGINS: 'https://lms.example.edu/, https://admin.example.edu',
      DOCUMENT_STORAGE_DIR: '/var/lib/academiapath/documents',
    });
    assert.equal(config.session.cookieName, '__Host-ap_session');
    assert.equal(config.session.cookieSecure, true);
    assert.deepEqual(config.allowedOrigins, ['https://lms.example.edu', 'https://admin.example.edu']);
  });

  it('keeps uploaded documents in an explicit private directory outside the repository', () => {
    const config = loadConfig({});
    assert.equal(config.documents.maxUploadBytes, 10 * 1024 * 1024);
    assert.equal(config.documents.extractionTimeoutMs, 20_000);
    assert.ok(config.documents.storageDir.endsWith('/.academiapath/documents'));
    assert.equal(loadConfig({ DOCUMENT_STORAGE_DIR: '/srv/ap-docs', DOCUMENT_MAX_UPLOAD_MB: '5' }).documents.maxUploadBytes, 5 * 1024 * 1024);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_ORIGINS: 'https://lms.example.edu' }), /DOCUMENT_STORAGE_DIR must be set/);
    assert.throws(() => loadConfig({ DOCUMENT_STORAGE_DIR: 'relative/dir' }), /absolute path/);
    const repoDir = new URL('../../../web/public/uploads', import.meta.url).pathname;
    assert.throws(() => loadConfig({ DOCUMENT_STORAGE_DIR: repoDir }), /outside the repository/);
    assert.throws(() => loadConfig({ DOCUMENT_MAX_UPLOAD_MB: '0' }), /DOCUMENT_MAX_UPLOAD_MB/);
  });

  it('accepts only explicit trusted-proxy settings, never "trust all"', () => {
    assert.equal(loadConfig({ TRUST_PROXY: 'false' }).trustProxy, false);
    assert.equal(loadConfig({ TRUST_PROXY: '10.0.0.0/8, 192.168.1.10' }).trustProxy, '10.0.0.0/8,192.168.1.10');
    assert.equal(loadConfig({ TRUST_PROXY: '2001:db8::/32' }).trustProxy, '2001:db8::/32');
    assert.throws(() => loadConfig({ TRUST_PROXY: 'true' }), /TRUST_PROXY=true/);
    assert.throws(() => loadConfig({ TRUST_PROXY: '1' }), /hop counts are not supported/);
    assert.throws(() => loadConfig({ TRUST_PROXY: 'proxy.internal' }), /invalid IP/);
    assert.throws(() => loadConfig({ TRUST_PROXY: '10.0.0.0/33' }), /invalid IP/);
  });

  it('fails fast on invalid settings', () => {
    assert.throws(() => loadConfig({ SESSION_TTL_HOURS: '0' }), /SESSION_TTL_HOURS/);
    assert.throws(() => loadConfig({ LOGIN_RATE_LIMIT_MAX: 'many' }), /LOGIN_RATE_LIMIT_MAX/);
    assert.throws(() => loadConfig({ APP_ORIGINS: 'not a url' }), /APP_ORIGINS/);
  });
});

describe('error handling without a database', () => {
  it('returns RFC 9457 problem details and fails closed when the session store is unavailable', async () => {
    const { db, pool } = createDatabase('postgresql://postgres@127.0.0.1:1/unreachable');
    const app = buildApp({ config: loadConfig({}), database: db });
    try {
      const me = await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { ap_session: generateSessionToken() } });
      assert.equal(me.statusCode, 500);
      assert.match(String(me.headers['content-type']), /^application\/problem\+json/);
      assert.deepEqual(me.json(), {
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred.',
        code: 'INTERNAL_ERROR',
      });

      const missing = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
      assert.deepEqual(missing.json(), {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Route not found.',
        code: 'NOT_FOUND',
      });
    } finally {
      await app.close();
      await pool.end();
    }
  });
});

describe('development seed guard', () => {
  const password = 'x'.repeat(12);

  it('refuses production, non-local databases and weak passwords', () => {
    const local = 'postgresql://localhost:5432/academiapath_dev';
    assert.throws(() => assertDevSeedAllowed({ NODE_ENV: 'production', DATABASE_URL: local, DEV_SEED_PASSWORD: password }), /production/);
    assert.throws(() => assertDevSeedAllowed({ DEV_SEED_PASSWORD: password }), /DATABASE_URL/);
    assert.throws(
      () => assertDevSeedAllowed({ DATABASE_URL: 'postgresql://db.university.example/lms', DEV_SEED_PASSWORD: password }),
      /not local/,
    );
    assert.throws(
      () => assertDevSeedAllowed({ DATABASE_URL: `${local}?host=db.university.example`, DEV_SEED_PASSWORD: password }),
      /not local/,
    );
    assert.throws(
      () => assertDevSeedAllowed({ DATABASE_URL: 'postgresql:///lms', PGHOST: 'db.university.example', DEV_SEED_PASSWORD: password }),
      /not local/,
    );
    assert.throws(() => assertDevSeedAllowed({ DATABASE_URL: local }), /DEV_SEED_PASSWORD/);
    assert.throws(() => assertDevSeedAllowed({ DATABASE_URL: local, DEV_SEED_PASSWORD: 'short' }), /DEV_SEED_PASSWORD/);
  });

  it('allows a local development database', () => {
    for (const url of [
      'postgresql://localhost:5432/academiapath_dev',
      'postgresql://127.0.0.1/academiapath_dev',
      'postgresql://[::1]:5432/academiapath_dev',
      'postgresql:///academiapath_dev?host=/var/run/postgresql',
    ]) {
      assert.deepEqual(assertDevSeedAllowed({ DATABASE_URL: url, DEV_SEED_PASSWORD: password }), {
        databaseUrl: url,
        password,
      });
    }
  });
});
