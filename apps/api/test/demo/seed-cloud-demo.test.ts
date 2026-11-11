/**
 * The one-off cloud demo seed: it runs only in the approved environment, refuses anything that is not the
 * synthetic demo database, provisions the five role accounts with unique credentials (never printed), seeds
 * the demo dataset idempotently, keeps creating and resetting credentials apart, and leaves no open sessions.
 * PostgreSQL parts run against temporary databases (skipped unless TEST_DATABASE_URL is set).
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { CLOUD_DEMO, parseDemoCredentials, readCredentialSource, resolveSeedRun, ROLE_ACCOUNTS, runtimeGuardDeps, type GuardDeps } from '../../scripts/demo/cloud.js';
import { assertDevSeedAllowed } from '../../scripts/seed-dev-users.js';
import { EXIT, runCloudDemoSeed } from '../../scripts/seed-cloud-demo.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const ORIGIN = 'http://localhost:3000';
const DB_SECRET = 'Db-Pa55word-NeverShown';
const CLOUD_URL = `postgresql://academiapath_app:${DB_SECRET}@localhost/academiapath?host=/cloudsql/${CLOUD_DEMO.sqlInstance}`;
const okDeps: GuardDeps = { projectId: async () => CLOUD_DEMO.projectId, isMountPoint: async (path) => path === CLOUD_DEMO.documentsMount };
const cloudEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  CLOUD_RUN_JOB: CLOUD_DEMO.jobName,
  DATABASE_URL: CLOUD_URL,
  DOCUMENT_STORAGE_DIR: CLOUD_DEMO.documentsMount,
  DEMO_SEED_TARGET: 'cloud-demo',
  DEMO_SEED_MODE: 'create',
  DEMO_SEED_CONFIRM: 'academiapath-demo',
  ...extra,
});
/** Every credential value generated in this file, for the final no-leak check. */
const generated: string[] = [];
const newCredentials = () => {
  const values = Object.fromEntries(ROLE_ACCOUNTS.map(({ email }) => [email, `Demo-${randomBytes(15).toString('base64url')}`]));
  generated.push(...Object.values(values));
  return values;
};
const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  return null;
};

describe('cloud demo seed: where it may run', () => {
  it('the cloud-demo target needs the seed job, the demo project, the demo database and the mounted bucket', async () => {
    assert.deepEqual(await resolveSeedRun(cloudEnv(), okDeps), { target: 'cloud-demo', mode: 'create', databaseUrl: CLOUD_URL });
    const cases: Array<[string, NodeJS.ProcessEnv, GuardDeps?]> = [
      ['not production', cloudEnv({ NODE_ENV: 'development' })],
      ['inside a Cloud Run service', cloudEnv({ K_SERVICE: 'academiapath-api' })],
      ['another Cloud Run job', cloudEnv({ CLOUD_RUN_JOB: 'academiapath-migrate' })],
      ['not on Cloud Run', cloudEnv({ CLOUD_RUN_JOB: undefined })],
      ['another project', cloudEnv(), { ...okDeps, projectId: async () => 'other-project' }],
      ['no metadata server', cloudEnv(), { ...okDeps, projectId: async () => null }],
      ['another Cloud SQL instance', cloudEnv({ DATABASE_URL: CLOUD_URL.replace('academiapath-db', 'itil-db') })],
      ['another database', cloudEnv({ DATABASE_URL: CLOUD_URL.replace('/academiapath?', '/itil?') })],
      ['a TCP database', cloudEnv({ DATABASE_URL: `postgresql://u:${DB_SECRET}@10.0.0.5/academiapath` })],
      ['another storage directory', cloudEnv({ DOCUMENT_STORAGE_DIR: '/tmp/documents' })],
      ['the bucket is not mounted', cloudEnv(), { ...okDeps, isMountPoint: async () => false }],
      ['no confirmation', cloudEnv({ DEMO_SEED_CONFIRM: undefined })],
      ['the local confirmation', cloudEnv({ DEMO_SEED_CONFIRM: 'local-demo' })],
      ['a reset without its second confirmation', cloudEnv({ DEMO_SEED_MODE: 'reset-credentials' })],
      ['an unknown mode', cloudEnv({ DEMO_SEED_MODE: 'drop' })],
      ['no target', cloudEnv({ DEMO_SEED_TARGET: undefined })],
    ];
    for (const [name, env, deps] of cases) {
      const message = await refusal(resolveSeedRun(env, deps ?? okDeps));
      assert.ok(message, `refused: ${name}`);
      assert.ok(!message.includes(DB_SECRET) && !message.includes('postgresql://'), `${name}: the database URL is never shown`);
    }
    // Read-only check mode needs no confirmation; a reset needs both.
    assert.equal((await resolveSeedRun(cloudEnv({ DEMO_SEED_MODE: 'check', DEMO_SEED_CONFIRM: undefined }), okDeps)).mode, 'check');
    assert.equal((await resolveSeedRun(cloudEnv({ DEMO_SEED_MODE: 'reset-credentials', DEMO_SEED_CONFIRM_RESET: 'reset-demo-credentials' }), okDeps)).mode, 'reset-credentials');
  });

  it('mount detection: a plain directory is not a mount point; the root of another file system is', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ap-mount-'));
    try {
      assert.equal(await runtimeGuardDeps.isMountPoint(dir), false);
      assert.equal(await runtimeGuardDeps.isMountPoint(join(dir, 'missing')), false);
      assert.equal(await runtimeGuardDeps.isMountPoint('/proc'), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the local target refuses production, Cloud Run and databases on other machines (including Cloud SQL)', async () => {
    const local = { DEMO_SEED_TARGET: 'local', DEMO_SEED_MODE: 'check', DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/demo' };
    assert.equal((await resolveSeedRun(local, okDeps)).target, 'local');
    for (const extra of [{ NODE_ENV: 'production' }, { K_SERVICE: 'academiapath-api' }, { CLOUD_RUN_JOB: CLOUD_DEMO.jobName }, { DATABASE_URL: 'postgresql://u:p@db.example.org/demo' }, { DATABASE_URL: CLOUD_URL }]) {
      assert.ok(await refusal(resolveSeedRun({ ...local, ...extra }, okDeps)), JSON.stringify(Object.keys(extra)));
    }
  });

  it('the development seeds keep refusing production, Cloud Run and Cloud SQL', () => {
    const dev = { DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/demo', DEV_SEED_PASSWORD: 'a-local-password-123' };
    assert.equal(assertDevSeedAllowed(dev).databaseUrl, dev.DATABASE_URL);
    assert.throws(() => assertDevSeedAllowed({ ...dev, NODE_ENV: 'production' }), /NODE_ENV is production/);
    assert.throws(() => assertDevSeedAllowed({ ...dev, CLOUD_RUN_JOB: 'academiapath-migrate' }), /inside Cloud Run/);
    assert.throws(() => assertDevSeedAllowed({ ...dev, K_SERVICE: 'academiapath-api' }), /inside Cloud Run/);
    assert.throws(() => assertDevSeedAllowed({ ...dev, DATABASE_URL: CLOUD_URL }), /is not local/);
    // A local Unix socket directory is still local.
    assert.ok(assertDevSeedAllowed({ ...dev, DATABASE_URL: 'postgresql:///demo?host=/var/run/postgresql' }));
  });

  it('credentials must cover exactly the five role accounts with distinct, policy-compliant passwords; values are never echoed', () => {
    const good = newCredentials();
    assert.equal(parseDemoCredentials(JSON.stringify(good)).size, 5);
    const secret = 'Secret-Value-Not-Shown-42';
    const bad: Array<[string, string]> = [
      ['invalid JSON', `{"admin@academiapath.example": "${secret}"`],
      ['an array', JSON.stringify([secret])],
      ['a missing account', JSON.stringify({ ...good, 'student@academiapath.example': undefined })],
      ['a learner account', JSON.stringify({ ...good, 'learner.a@academiapath.example': secret })],
      ['a real address', JSON.stringify({ ...good, 'someone@university.edu.pe': secret })],
      ['a short password', JSON.stringify({ ...good, 'admin@academiapath.example': 'short-1' })],
      ['the email name', JSON.stringify({ ...good, 'student@academiapath.example': 'my-student-password-1' })],
      ['a repeated character', JSON.stringify({ ...good, 'ta@academiapath.example': 'aaaaaaaaaaaaaaaa' })],
      ['a shared password', JSON.stringify({ ...good, 'ta@academiapath.example': good['admin@academiapath.example'] })],
      ['a number', JSON.stringify({ ...good, 'reviewer@academiapath.example': 123456789012345 })],
      ['nothing', ''],
    ];
    for (const [name, raw] of bad) {
      let message = '';
      assert.throws(() => parseDemoCredentials(raw), (error: Error) => ((message = error.message), true), name);
      for (const value of [secret, ...Object.values(good)]) assert.ok(!message.includes(value), `${name}: no credential value in "${message}"`);
    }
  });

  it('a credentials file is for the local target only and must be readable by its owner only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ap-creds-'));
    try {
      const file = join(dir, 'creds.json');
      await writeFile(file, JSON.stringify(newCredentials()), { mode: 0o644 });
      await chmod(file, 0o644);
      assert.match((await refusal(readCredentialSource({ DEMO_ACCOUNT_CREDENTIALS_FILE: file }, 'local'))) ?? '', /chmod 600/);
      await chmod(file, 0o600);
      assert.ok((await readCredentialSource({ DEMO_ACCOUNT_CREDENTIALS_FILE: file }, 'local'))?.includes('@academiapath.example'));
      assert.match((await refusal(readCredentialSource({ DEMO_ACCOUNT_CREDENTIALS_FILE: file }, 'cloud-demo'))) ?? '', /local target only/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('cloud demo seed on PostgreSQL', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let storageDir: string;
  let credentials = newCredentials();
  const output: string[] = [];
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await database.pool.query(text, params)).rows as T[];

  const run = async (mode: string, extra: NodeJS.ProcessEnv = {}) => {
    const lines: string[] = [];
    const code = await runCloudDemoSeed(
      {
        DATABASE_URL: database.url,
        DOCUMENT_STORAGE_DIR: storageDir,
        LOG_LEVEL: 'warn',
        DEMO_SEED_TARGET: 'local',
        DEMO_SEED_MODE: mode,
        DEMO_SEED_CONFIRM: 'local-demo',
        DEMO_ACCOUNT_CREDENTIALS: JSON.stringify(credentials),
        ...extra,
      },
      okDeps,
      (line) => lines.push(line),
    );
    output.push(...lines);
    return { code, text: lines.join('\n'), lines };
  };
  /** Row count and content hash of every table except those listed. */
  const fingerprint = async (except: string[] = []) => {
    const rows = await q<{ table_name: string; h: string }>(
      `SELECT t.table_name,
        (xpath('/row/h/text()', query_to_xml(format('SELECT count(*) || '':'' || md5(coalesce(string_agg(x::text, ''|'' ORDER BY x::text), '''')) AS h FROM %I x', t.table_name), false, true, '')))[1]::text AS h
       FROM information_schema.tables t WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE' ORDER BY t.table_name`,
    );
    return Object.fromEntries(rows.filter((r) => !except.includes(r.table_name)).map((r) => [r.table_name, r.h]));
  };
  const app = () => buildApp({ config: { ...loadConfig({ DOCUMENT_STORAGE_DIR: storageDir }), loginRateLimit: { max: 1000, windowMs: 60_000 } }, database: database.db });
  /** Signs in through the real login route; returns the status and, on success, a request helper. */
  const signInAs = async (email: string, password: string) => {
    const instance = app();
    await instance.ready();
    const login = await instance.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, payload: { email, password } });
    const cookies = Object.fromEntries(login.cookies.map((c) => [c.name, c.value]));
    const csrf = login.statusCode === 200 ? (login.json() as { csrfToken: string }).csrfToken : '';
    const call = async (method: 'GET' | 'POST', url: string, payload?: object) => {
      const res = await instance.inject({ method, url: `/api/v1${url}`, cookies, headers: { origin: ORIGIN, ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }) }, ...(payload ? { payload } : {}) });
      return { status: res.statusCode, json: res.body ? (res.json() as Record<string, unknown> & { items?: Array<Record<string, unknown>> }) : null };
    };
    return { status: login.statusCode, call, close: () => instance.close() };
  };
  const statusOf = async (email: string, password: string) => {
    const session = await signInAs(email, password);
    await session.close();
    return session.status;
  };
  const counts = (text: string) => [...text.matchAll(/^ {2}[a-z ]+?\s+(\d+) \/ (\d+)$/gm)].map((m) => Number(m[1]));

  before(async () => {
    database = await createTestDatabase();
    storageDir = await mkdtemp(join(tmpdir(), 'ap-cloud-seed-docs-'));
  });
  after(async () => {
    await database?.drop();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it('check on an empty, migrated database reports readiness and changes nothing', async () => {
    const before = await fingerprint();
    const result = await run('check', { DEMO_SEED_CONFIRM: undefined });
    assert.equal(result.code, EXIT.ok, result.text);
    assert.match(result.text, /0 of 5 role accounts exist/);
    assert.match(result.text, /Ready\. Nothing was changed\./);
    assert.deepEqual(await fingerprint(), before);
  });

  it('create provisions five role accounts with their own credentials, passwordless learners and the demo dataset', async () => {
    const result = await run('create');
    assert.equal(result.code, EXIT.ok, result.text);
    assert.match(result.text, /Sign-in check: 5\/5 role accounts sign in/);
    const [openRow] = await q<{ n: number }>('SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > now()');
    assert.equal(openRow!.n, 0, 'the seed leaves no open session');
    for (const { email } of ROLE_ACCOUNTS) assert.match(result.text, new RegExp(`${email.replace('.', '\\.')}.*created, password set`));
    const accounts = await q<{ email: string; system_role: string; has_password: boolean }>(
      'SELECT u.email, u.system_role, c.user_id IS NOT NULL AS has_password FROM users u LEFT JOIN user_credentials c ON c.user_id = u.id ORDER BY u.email',
    );
    assert.equal(accounts.length, 7);
    assert.deepEqual(accounts.filter((a) => a.has_password).map((a) => a.email).sort(), ROLE_ACCOUNTS.map((a) => a.email).sort());
    assert.deepEqual(accounts.filter((a) => a.system_role === 'administrator').map((a) => a.email), ['admin@academiapath.example']);
    for (const { email } of ROLE_ACCOUNTS) assert.equal(await statusOf(email, credentials[email]!), 200, email);
    assert.equal(await statusOf('student@academiapath.example', credentials['instructor@academiapath.example']!), 401, 'passwords are per account');
    const roles = await q<{ email: string; code: string; role: string }>(
      'SELECT u.email, c.code, e.role FROM enrollments e JOIN users u ON u.id = e.user_id JOIN courses c ON c.id = e.course_id ORDER BY 1, 2',
    );
    const has = (email: string, code: string, role: string) => roles.some((r) => r.email === email && r.code === code && r.role === role);
    assert.ok(has('instructor@academiapath.example', 'ITIL4-F-2026-2-A', 'instructor'));
    assert.ok(has('reviewer@academiapath.example', 'ITIL4-F-2026-2-A', 'design_team'));
    assert.ok(has('ta@academiapath.example', 'ITIL4-F-2026-2-A', 'non_editing_instructor'));
    assert.ok(has('ta@academiapath.example', 'IAI-2026-2-A', 'student'));
    assert.ok(['ITIL4-F-2026-2-A', 'PMF-2026-2-A', 'IAI-2026-2-A'].every((code) => has('student@academiapath.example', code, 'student')));
    const [documentRow] = await q<{ n: number }>('SELECT count(*)::int AS n FROM course_documents');
    assert.equal(documentRow!.n, 3, 'three documents uploaded into the configured private storage');
    const [runRow] = await q<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action = 'system.demo_seed' AND actor_user_id IS NULL");
    assert.equal(runRow!.n, 1, 'the run is audited');
  });

  it('each role account reaches its courses and features: dashboards, quizzes, assignments, gradebook, certificates, announcements, calendar', async () => {
    const student = await signInAs('student@academiapath.example', credentials['student@academiapath.example']!);
    const studentCourses = (await student.call('GET', '/courses?limit=100')).json!.items!;
    assert.deepEqual(studentCourses.map((c) => c.code).sort(), ['IAI-2026-2-A', 'ITIL4-F-2026-2-A', 'PMF-2026-2-A'], 'published courses only');
    const course = (code: string) => studentCourses.find((c) => c.code === code)!.id as string;
    assert.equal((await student.call('GET', '/me/progress')).status, 200);
    const pmfGrades = await student.call('GET', `/courses/${course('PMF-2026-2-A')}/grades/mine`);
    assert.equal(pmfGrades.status, 200);
    assert.equal((await student.call('GET', `/courses/${course('PMF-2026-2-A')}/certificates/mine`)).status, 200);
    const feed = (await student.call('GET', '/me/announcements')).json!.items!.map((a) => a.title);
    assert.ok(feed.includes('Bienvenidos al módulo de práctica') && feed.includes('Cierre del semestre 2026-2') && !feed.includes('Recordatorio: entrega de la tarea'), 'scheduled announcement stays hidden');
    const calendar = (await student.call('GET', '/me/calendar')).json as { events: Array<{ title: string }> };
    assert.ok(calendar.events.some((e) => e.title === 'Sesión de repaso en vivo: ITIL 4'), 'the course event (two days after seeding)');
    const term = (await student.call('GET', '/me/calendar?from=2026-11-01T00:00:00-05:00&to=2026-12-31T00:00:00-05:00')).json as { dueDates: unknown[] };
    assert.ok(term.dueDates.length >= 2, 'assignment due dates of the enrolled courses');
    await student.close();

    const instructor = await signInAs('instructor@academiapath.example', credentials['instructor@academiapath.example']!);
    const itil = (await instructor.call('GET', '/courses?limit=100')).json!.items!.find((c) => c.code === 'ITIL4-F-2026-2-A')!.id as string;
    assert.equal((await instructor.call('GET', `/courses/${itil}/gradebook?limit=100`)).status, 200);
    assert.equal((await instructor.call('GET', `/courses/${itil}/certificates/eligibility`)).status, 200);
    const staffList = (await instructor.call('GET', `/courses/${itil}/announcements?status=all`)).json!.items!.map((a) => a.status);
    assert.ok(staffList.includes('scheduled'), 'instructors see the scheduled announcement');
    await instructor.close();

    const ta = await signInAs('ta@academiapath.example', credentials['ta@academiapath.example']!);
    assert.equal((await ta.call('GET', `/courses/${itil}/gradebook?limit=100`)).status, 200);
    assert.equal((await ta.call('POST', `/courses/${itil}/announcements`, { title: 'x', body: 'y' })).status, 403, 'non-editing instructors cannot publish');
    await ta.close();

    const reviewer = await signInAs('reviewer@academiapath.example', credentials['reviewer@academiapath.example']!);
    assert.equal((await reviewer.call('GET', `/courses/${itil}`)).json!.viewerRole, 'design_team');
    await reviewer.close();

    const admin = await signInAs('admin@academiapath.example', credentials['admin@academiapath.example']!);
    assert.equal((await admin.call('GET', '/users?limit=100')).json!.items!.length, 7);
    await admin.close();
  });

  it('a second create run creates nothing, changes no record and keeps every password', async () => {
    const before = await fingerprint(['audit_log', 'sessions']);
    const result = await run('create');
    assert.equal(result.code, EXIT.ok, result.text);
    assert.ok(counts(result.text).length > 10 && counts(result.text).every((created) => created === 0), 'nothing created');
    assert.match(result.text, /admin@academiapath\.example.*existing, password unchanged/);
    assert.deepEqual(await fingerprint(['audit_log', 'sessions']), before);
  });

  it('create never replaces an existing password: new credentials are reported as not applied', async () => {
    const previous = credentials;
    credentials = newCredentials();
    const result = await run('create');
    assert.equal(result.code, EXIT.signIn, result.text);
    assert.match(result.text, /SIGN-IN FAILED: admin@academiapath\.example/);
    assert.equal(await statusOf('admin@academiapath.example', previous['admin@academiapath.example']!), 200, 'old password still valid');
    assert.equal(await statusOf('admin@academiapath.example', credentials['admin@academiapath.example']!), 401);
    credentials = previous;
  });

  it('reset-credentials replaces only the five role passwords and ends their open sessions', async () => {
    const open = await signInAs('student@academiapath.example', credentials['student@academiapath.example']!);
    assert.equal((await open.call('GET', '/me')).status, 200);
    const before = await fingerprint(['user_credentials', 'sessions', 'audit_log']);
    const [learners] = await q<{ n: number }>("SELECT count(*)::int AS n FROM user_credentials c JOIN users u ON u.id = c.user_id WHERE u.email LIKE 'learner.%'");
    const previous = credentials;
    credentials = newCredentials();
    assert.equal((await run('reset-credentials')).code, EXIT.refused, 'needs the second confirmation');
    const result = await run('reset-credentials', { DEMO_SEED_CONFIRM_RESET: 'reset-demo-credentials' });
    assert.equal(result.code, EXIT.ok, result.text);
    assert.match(result.text, /student@academiapath\.example +open sessions ended: [1-9]\d*/);
    assert.equal((await open.call('GET', '/me')).status, 401, 'the old session ended');
    await open.close();
    for (const { email } of ROLE_ACCOUNTS) {
      assert.equal(await statusOf(email, previous[email]!), 401, `${email}: old password rejected`);
      assert.equal(await statusOf(email, credentials[email]!), 200, `${email}: new password accepted`);
    }
    assert.deepEqual(await fingerprint(['user_credentials', 'sessions', 'audit_log']), before, 'nothing else changed');
    const [learnersAfter] = await q<{ n: number }>("SELECT count(*)::int AS n FROM user_credentials c JOIN users u ON u.id = c.user_id WHERE u.email LIKE 'learner.%'");
    assert.equal(learnersAfter!.n, learners!.n);
  });

  it('accounts or academic records that are not demo data stop the seed before any change', async () => {
    const outsider = randomUUID();
    await q("INSERT INTO users (id, email, given_name, family_name) VALUES ($1, 'maria.quispe@university.edu.pe', 'María', 'Quispe')", [outsider]);
    try {
      const before = await fingerprint();
      for (const [mode, extra] of [['check', {}], ['create', {}], ['reset-credentials', { DEMO_SEED_CONFIRM_RESET: 'reset-demo-credentials' }]] as const) {
        const result = await run(mode, extra);
        assert.equal(result.code, EXIT.notReady, `${mode}: ${result.text}`);
        assert.match(result.text, /1 account\(s\) are not synthetic demo accounts/);
        assert.ok(!result.text.includes('maria.quispe'), 'other accounts are not named');
      }
      assert.deepEqual(await fingerprint(), before, 'nothing changed');
    } finally {
      await q('DELETE FROM users WHERE id = $1', [outsider]);
    }
    await q("INSERT INTO programs (code, name) VALUES ('MBA', 'Master of Business Administration')");
    try {
      const result = await run('create');
      assert.equal(result.code, EXIT.notReady);
      assert.match(result.text, /1 programs are not demo fixtures \(MBA\)/);
      // A credential reset touches only the five demo accounts, so extra academic records do not block it.
      assert.equal((await run('reset-credentials', { DEMO_SEED_CONFIRM_RESET: 'reset-demo-credentials' })).code, EXIT.ok);
    } finally {
      await q("DELETE FROM programs WHERE code = 'MBA'");
    }
    await q("UPDATE users SET system_role = 'administrator' WHERE email = 'student@academiapath.example'");
    try {
      const result = await run('check', { DEMO_SEED_CONFIRM: undefined });
      assert.equal(result.code, EXIT.notReady);
      assert.match(result.text, /student@academiapath\.example has system role "administrator"/);
    } finally {
      await q("UPDATE users SET system_role = 'user' WHERE email = 'student@academiapath.example'");
    }
  });

  it('a document row without its stored file stops the seed (the bucket must be mounted)', async () => {
    const [stored] = await q<{ key: string }>('SELECT storage_key AS key FROM course_documents LIMIT 1');
    const key = stored!.key;
    await rename(join(storageDir, key), join(storageDir, `${key}.moved`));
    try {
      const result = await run('check', { DEMO_SEED_CONFIRM: undefined });
      assert.equal(result.code, EXIT.notReady);
      assert.match(result.text, /1 uploaded document file\(s\) are missing/);
    } finally {
      await rename(join(storageDir, `${key}.moved`), join(storageDir, key));
    }
    assert.equal((await run('check', { DEMO_SEED_CONFIRM: undefined })).code, EXIT.ok);
  });

  it('only one seed runs at a time', async () => {
    const holder = await database.pool.connect();
    await holder.query('SELECT pg_advisory_lock(4172025)');
    try {
      const result = await run('check', { DEMO_SEED_CONFIRM: undefined });
      assert.equal(result.code, EXIT.refused);
      assert.match(result.text, /another demo seed run is in progress/);
    } finally {
      await holder.query('SELECT pg_advisory_unlock(4172025)');
      holder.release();
    }
  });

  it('an unmigrated database is not ready', async () => {
    const server = new URL(testServerUrl!);
    const name = `academiapath_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const admin = new pg.Client({ connectionString: testServerUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    try {
      server.pathname = `/${name}`;
      const lines: string[] = [];
      const code = await runCloudDemoSeed(
        { DATABASE_URL: server.toString(), DOCUMENT_STORAGE_DIR: storageDir, DEMO_SEED_TARGET: 'local', DEMO_SEED_MODE: 'check', DEMO_ACCOUNT_CREDENTIALS: JSON.stringify(credentials) },
        okDeps,
        (line) => lines.push(line),
      );
      output.push(...lines);
      assert.equal(code, EXIT.notReady, lines.join('\n'));
      assert.match(lines.join('\n'), /no migrations have been applied/);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('no output line contains a credential, a password hash or the database URL', async () => {
    const all = output.join('\n');
    assert.ok(output.length > 50);
    const hashes = await q<{ h: string }>('SELECT password_hash AS h FROM user_credentials');
    assert.ok(generated.length >= 15);
    for (const value of [...generated, ...hashes.map((r) => r.h), database.url, '$argon2']) assert.ok(!all.includes(value), 'secret value found in output');
  });
});
