/**
 * AP-OPS-03: durable storage recovery plans and approvals (src/documents/approved-recovery.ts, migration 0038) against
 * a simulated Cloud Storage JSON API (test/helpers/fake-gcs.ts) backed by the directory the application writes to, with
 * operators verified by a signed-token test identity provider (test/helpers/operator-identity.ts). Abandoned files
 * come from real uploads killed with SIGKILL, and workers are killed with SIGKILL after claiming a plan and after
 * deleting an object (test/helpers/storage-crash-child.ts). Disposable PostgreSQL, synthetic files, no real Cloud
 * Storage. Numbers in the test names refer to the AP-OPS-03 test list.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { main as approvedCli, APPROVED_EXIT } from '../../scripts/storage-recover-approved.js';
import { seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { programs, terms, users } from '../../src/db/schema/index.js';
import {
  approveRecoveryPlan,
  claimRecoveryPlan,
  createRecoveryPlan,
  executeRecoveryPlan,
  keyRef,
  previewRecovery,
  reviewRecoveryPlan,
  revokeRecoveryPlan,
  runRecoveryPlan,
  type ExecutionReport,
  type PlanReview,
  type RecoveryDeps,
} from '../../src/documents/approved-recovery.js';
import { GcsJsonObjectStore, type RecoveryObjectStore } from '../../src/documents/object-store.js';
import { NO_TRUSTED_OPERATOR_IDENTITY } from '../../src/documents/operator-identity.js';
import { LocalDocumentStorage } from '../../src/documents/storage.js';
import { openStorageJournal } from '../../src/documents/storage-journal.js';
import { createTestDatabase, migrationsBefore, migrationsFolder, testServerUrl } from '../helpers/database.js';
import { makePdf, multipartBody } from '../helpers/documents.js';
import { generationOf, startFakeGcs, type FakeGcs } from '../helpers/fake-gcs.js';
import { testOperatorIdentity } from '../helpers/operator-identity.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';
const BUCKET = 'ap-test-documents';
const DATABASE_ID = 'test-host:5432/recovery-approvals';
const ENVIRONMENT = 'test';
const OPS = { planner: 'planner@ops.example', approver: 'approver@ops.example', approver2: 'approver2@ops.example', executor: 'executor@ops.example', executor2: 'executor2@ops.example', lead: 'lead@ops.example' };
const CHILD = fileURLToPath(new URL('../helpers/storage-crash-child.ts', import.meta.url));
const API_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHILD_APP = 'ap-recovery-approvals-child';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const refusal = (result: { ok: boolean }) => (result.ok ? 'ok' : (result as unknown as { refusal: string }).refusal);
const outcomes = (report: ExecutionReport) => report.entries.map((entry) => entry.outcome).sort();
type Intent = { id: string; storage_key: string; attempts: number; last_error: string | null };

describe('durable storage recovery approvals (AP-OPS-03, PostgreSQL, simulated API)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let root: string;
  let storageDir: string;
  let local: LocalDocumentStorage;
  let gcs: FakeGcs;
  let store: GcsJsonObjectStore;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let session: { token: string; csrf: string };
  const ids = {} as Record<'admin' | 'program' | 'term' | 'course' | 'section', string>;
  const idp = testOperatorIdentity();
  const cred = {
    planner: idp.issue(OPS.planner, ['storage_recovery.planner'], { ttlSeconds: 3600 }),
    approver: idp.issue(OPS.approver, ['storage_recovery.approver'], { ttlSeconds: 3600 }),
    approver2: idp.issue(OPS.approver2, ['storage_recovery.approver'], { ttlSeconds: 3600 }),
    executor: idp.issue(OPS.executor, ['storage_recovery.executor'], { ttlSeconds: 3600 }),
    executor2: idp.issue(OPS.executor2, ['storage_recovery.executor'], { ttlSeconds: 3600 }),
    lead: idp.issue(OPS.lead, ['storage_recovery.planner', 'storage_recovery.approver', 'storage_recovery.executor'], { ttlSeconds: 3600 }),
  };
  /** Every storage key this suite creates: none may ever appear in a plan, an entry or an audit record. */
  const allKeys = new Set<string>();

  const q = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await database.pool.query<T>(text, params)).rows;
  const files = async () => (await readdir(storageDir).catch(() => [] as string[])).sort();
  const intents = () => q<Intent>('SELECT id, storage_key, attempts, last_error FROM document_storage_intents ORDER BY created_at, id');
  const expireLeases = () => q(`UPDATE document_storage_intents SET lease_expires_at = now() - interval '1 second'`);
  const unreferenced = async () => {
    const known = new Set((await q<{ storage_key: string }>('SELECT storage_key FROM course_documents')).map((row) => row.storage_key));
    return (await files()).filter((name) => !known.has(name));
  };
  const assertClean = async (label: string) => {
    assert.deepEqual(await intents(), [], `${label}: no journal entry left`);
    assert.deepEqual(await unreferenced(), [], `${label}: no unreferenced file left`);
  };
  const deps = (overrides: Partial<RecoveryDeps> = {}): RecoveryDeps => ({ db: database.db, store, identity: idp.provider, database: DATABASE_ID, environment: ENVIRONMENT, ...overrides });
  const create = async (options: { ttlSeconds?: number } = {}) => {
    const result = await createRecoveryPlan(deps(), { credential: cred.planner, ...options });
    assert.ok(result.ok && result.plan, JSON.stringify(result));
    return result.plan;
  };
  const approve = async (plan: PlanReview, credential = cred.approver) => {
    const result = await approveRecoveryPlan(deps(), { credential, planId: plan.id, digest: plan.digest });
    assert.ok(result.ok, JSON.stringify(result));
    return result.plan;
  };
  const approved = async (options: { ttlSeconds?: number } = {}) => approve(await create(options));
  const run = async (planId: string, credential = cred.executor, overrides: Partial<RecoveryDeps> = {}) => {
    const result = await runRecoveryPlan(deps(overrides), { credential, planId });
    assert.ok(result.ok, JSON.stringify(result));
    return result.report;
  };
  const planRow = async (id: string) => (await q<Record<string, any>>('SELECT * FROM storage_recovery_plans WHERE id = $1', [id]))[0]!;
  const entryRows = (id: string) => q<{ intent_id: string; state: string; outcome: string | null; error_code: string | null; attempts: number }>('SELECT intent_id, state, outcome, error_code, attempts FROM storage_recovery_plan_entries WHERE plan_id = $1 ORDER BY intent_id', [id]);
  const planEvents = (id: string) => q<{ action: string; metadata: Record<string, any> }>(`SELECT action, metadata FROM audit_log WHERE entity_type = 'storage_recovery_plan' AND entity_id = $1 ORDER BY created_at, id`, [id]);
  const deletes = () => gcs.requests.filter((request) => request.method === 'DELETE');
  /** Takes every remaining abandoned entry through the whole lifecycle, so each test leaves a clean journal. */
  const finish = async (label: string) => {
    gcs.reset();
    await expireLeases();
    const result = await createRecoveryPlan(deps(), { credential: cred.planner });
    assert.ok(result.ok, JSON.stringify(result));
    if (result.plan) assert.equal((await run((await approve(result.plan)).id)).status, 'completed');
    await assertClean(label);
  };
  /** Abandoned writes as a dead writer leaves them: journaled, stored (unless `unwritten`), lease run out. */
  const abandoned = async (count: number, options: { unwritten?: boolean } = {}) => {
    const journal = openStorageJournal(database.db, 'document_upload', ids.admin);
    const keys: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const key = await journal.reserve();
      allKeys.add(key);
      if (!options.unwritten) await local.put(Buffer.from(`synthetic abandoned file ${i} ${randomUUID()}`), key);
      keys.push(key);
    }
    await q(`UPDATE document_storage_intents SET lease_expires_at = now() - interval '1 second' WHERE operation_id = $1`, [journal.operationId]);
    return keys;
  };
  const uploadDocument = async () => {
    const { payload, contentType } = multipartBody([{ name: 'file', filename: 'kept.pdf', data: makePdf([['Kept', `A referenced document ${randomUUID()}.`]]) }]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/courses/${ids.course}/sections/${ids.section}/documents`,
      payload,
      cookies: { ap_session: session.token },
      headers: { 'content-type': contentType, 'x-csrf-token': session.csrf, origin: ORIGIN },
    });
    assert.equal(res.statusCode, 201, res.body);
    return (await q<{ storage_key: string }>('SELECT storage_key FROM course_documents WHERE id = $1', [res.json().document.id]))[0]!.storage_key;
  };
  /** Rewrites an object with new content and a later modification time: a new generation, as in Cloud Storage. */
  const rewrite = async (key: string) => {
    await writeFile(join(storageDir, key), `rewritten ${randomUUID()}`);
    const later = new Date(Date.now() + 60_000 + Math.floor(Math.random() * 60_000));
    await utimes(join(storageDir, key), later, later);
  };
  /** Runs SQL as a superuser with triggers disabled: the kind of tampering only digest integrity can catch. */
  const bypassTriggers = async (text: string, params: unknown[] = []) => {
    const client = await database.pool.connect();
    try {
      await client.query('SET session_replication_role = replica');
      await client.query(text, params);
    } finally {
      await client.query('RESET session_replication_role');
      client.release();
    }
  };
  const wrapped = (overrides: Partial<RecoveryObjectStore>): RecoveryObjectStore => ({
    bucket: store.bucket,
    endpoint: store.endpoint,
    prefix: store.prefix,
    stat: (key) => store.stat(key),
    deleteGeneration: (key, generation) => store.deleteGeneration(key, generation),
    ...overrides,
  });

  const childGone = async () => {
    for (let i = 0; i < 200 && Number((await q<{ n: string }>('SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = $1', [CHILD_APP]))[0]!.n) > 0; i += 1) await sleep(50);
  };
  /** A child process (real SIGKILL): an upload, or a recovery worker. */
  const child = (env: Record<string, string>) => {
    const url = new URL(database.url);
    url.searchParams.set('application_name', CHILD_APP);
    const proc = spawn(process.execPath, ['--import', 'tsx', CHILD], {
      cwd: API_ROOT,
      env: { ...process.env, CRASH_DATABASE_URL: url.toString(), CRASH_STORAGE_DIR: storageDir, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    proc.stderr.on('data', () => undefined);
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    return {
      paused: async () => {
        for (let i = 0; i < 1200 && !out.includes('PAUSED'); i += 1) await sleep(50);
        assert.ok(out.includes('PAUSED'), `child did not pause: ${out.slice(-300)}`);
      },
      kill: async () => {
        proc.kill('SIGKILL');
        await exited;
        await childGone();
      },
    };
  };
  const workerEnv = (planId: string, claimTtl: number) => ({
    CRASH_PLAN_ID: planId,
    CRASH_IDENTITY_KEY: idp.keyHex,
    CRASH_CREDENTIAL: cred.executor,
    CRASH_CLAIM_TTL: String(claimTtl),
    CRASH_BUCKET: BUCKET,
    CRASH_API_URL: gcs.url,
    CRASH_DATABASE_ID: DATABASE_ID,
    CRASH_ENVIRONMENT: ENVIRONMENT,
  });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ap-recovery-approvals-'));
    storageDir = join(root, 'store');
    local = new LocalDocumentStorage(storageDir);
    await local.put(Buffer.from('warm-up'), randomUUID()).then((key) => local.remove(key));
    gcs = await startFakeGcs({ bucket: BUCKET, dir: storageDir });
    store = new GcsJsonObjectStore({ bucket: BUCKET, baseUrl: gcs.url, getAccessToken: async () => 'local-emulator', timeoutMs: 400 });
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    ids.admin = (await database.db.select({ id: users.id }).from(users).where(and(eq(users.systemRole, 'administrator'), eq(users.isActive, true))))[0]!.id;
    app = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', DOCUMENT_STORAGE_DIR: storageDir }), database: database.db, documents: { storage: local } });
    await app.ready();
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'admin@academiapath.example', password: PASSWORD }, headers: { origin: ORIGIN } });
    session = { token: login.cookies.find((c) => c.name === 'ap_session')!.value, csrf: login.json().csrfToken };
    const call = async (method: 'GET' | 'POST', url: string, payload?: object) =>
      (await app.inject({ method, url: `/api/v1${url}`, ...(payload ? { payload } : {}), cookies: { ap_session: session.token }, headers: { 'x-csrf-token': session.csrf, origin: ORIGIN } })).json();
    ids.program = (await database.db.insert(programs).values({ code: 'RAP', name: 'Recovery approvals' }).returning({ id: programs.id }))[0]!.id;
    ids.term = (await database.db.insert(terms).values({ code: '2026-2', name: '2026-II', academicYear: 2026, startsOn: '2026-08-17', endsOn: '2026-12-11' }).returning({ id: terms.id }))[0]!.id;
    const template = (await call('POST', '/course-templates', { code: 'RAP-T', programId: ids.program, title: 'Recovery approvals course', sections: [{ title: 'Unit 1' }] })).templateId;
    ids.course = (await call('POST', '/courses', { programId: ids.program, termId: ids.term, templateId: template, code: 'RAP-1', status: 'published' })).id;
    ids.section = (await call('GET', `/courses/${ids.course}/sections`)).items[0].id;
    await uploadDocument(); // documents whose files the storage witness can check
  });

  beforeEach(() => gcs?.reset());

  after(async () => {
    await app?.close();
    await gcs?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('1. a valid plan: server-generated id, bound to its environment, the exact entries and generations reviewed, an explicit expiry; creating it changes nothing', async () => {
    await writeFile(join(root, 'upload.pdf'), makePdf([['Crash', 'Interrupted upload.']]));
    const upload = child({ CRASH_MODE: 'upload', CRASH_PAUSE: 'after-put:1', CRASH_FILE: join(root, 'upload.pdf'), CRASH_COURSE: ids.course, CRASH_SECTION: ids.section, CRASH_SESSION: session.token, CRASH_CSRF: session.csrf });
    await upload.paused();
    await upload.kill();
    await expireLeases();
    const [key] = await unreferenced();
    assert.ok(key);
    allKeys.add(key);
    const [intent] = await intents();
    gcs.reset();
    const journalBefore = await intents();
    const filesBefore = await files();
    const plan = await create({ ttlSeconds: 900 });
    assert.match(plan.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'a server-generated UUID');
    assert.equal(plan.status, 'awaiting_approval');
    assert.deepEqual(plan.binding, { environment: ENVIRONMENT, database: DATABASE_ID, endpoint: gcs.url, bucket: BUCKET, prefix: '' });
    assert.deepEqual(plan.createdBy, { issuer: idp.issuer, subject: OPS.planner });
    assert.equal(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt), 900_000, 'expires after exactly the requested period');
    assert.deepEqual(
      plan.entries.map((entry) => [entry.intentId, entry.operation, entry.keyRef, entry.action, entry.generation, entry.state]),
      [[intent!.id, 'document_upload', keyRef(key), 'delete', await generationOf(join(storageDir, key)), 'pending']],
    );
    assert.deepEqual([plan.integrity, plan.approvedBy, plan.summary.counts.proposedDeletions], ['intact', null, 1]);
    assert.deepEqual([await intents(), await files()], [journalBefore, filesBefore], 'creating a plan changes no journal entry and no file');
    assert.ok(gcs.requests.every((request) => request.method === 'GET'), 'it only read object metadata');
    assert.deepEqual((await planEvents(plan.id)).map((event) => [event.action, event.metadata.after.operator.subject]), [['storage.recovery_plan_created', OPS.planner]]);
    const report = await run((await approve(plan)).id);
    assert.deepEqual([report.status, outcomes(report)], ['completed', ['file_removed']]);
    assert.deepEqual(deletes().map((request) => request.query.ifGenerationMatch), [plan.entries[0]!.generation], 'deleted exactly the reviewed generation');
    await finish('valid plan');
  });

  it('2. plan contents are immutable: no edit, insertion, deletion or invalid transition is accepted, whatever the database role', async () => {
    await abandoned(2);
    const plan = await create();
    const [first] = plan.entries;
    for (const [label, statement, params, expected] of [
      ['entry generation', `UPDATE storage_recovery_plan_entries SET generation = '1' WHERE plan_id = $1`, [plan.id], /plan entries are immutable/],
      ['entry action', `UPDATE storage_recovery_plan_entries SET action = 'forget_missing', generation = NULL WHERE plan_id = $1`, [plan.id], /plan entries are immutable/],
      ['entry outcome before execution', `UPDATE storage_recovery_plan_entries SET state = 'done' WHERE plan_id = $1`, [plan.id], /recorded only while/],
      ['bucket', `UPDATE storage_recovery_plans SET bucket = 'ap-other-bucket' WHERE id = $1`, [plan.id], /plan contents are immutable/],
      ['digest', `UPDATE storage_recovery_plans SET digest = repeat('a', 64) WHERE id = $1`, [plan.id], /plan contents are immutable/],
      ['expiry', `UPDATE storage_recovery_plans SET expires_at = expires_at + interval '1 day' WHERE id = $1`, [plan.id], /plan contents are immutable/],
      ['creator', `UPDATE storage_recovery_plans SET created_by_subject = 'someone-else' WHERE id = $1`, [plan.id], /plan contents are immutable/],
      [
        'skipping approval',
        `UPDATE storage_recovery_plans SET status = 'applying', claim_token = gen_random_uuid(), claim_expires_at = now() + interval '1 minute', claimed_by_subject = 'x' WHERE id = $1`,
        [plan.id],
        /invalid storage recovery plan transition from awaiting_approval to applying/,
      ],
      ['new entry', `INSERT INTO storage_recovery_plan_entries (plan_id, intent_id, operation, key_ref, action) VALUES ($1, gen_random_uuid(), 'document_upload', repeat('b', 64), 'forget_missing')`, [plan.id], /only be added/],
      ['deleting an entry', `DELETE FROM storage_recovery_plan_entries WHERE plan_id = $1 AND intent_id = $2`, [plan.id, first!.intentId], /plan entries are permanent records/],
      ['deleting the plan', `DELETE FROM storage_recovery_plans WHERE id = $1`, [plan.id], /plans are permanent records/],
      ['truncating plans', 'TRUNCATE storage_recovery_plans CASCADE', [], /TRUNCATE is not allowed/],
      ['truncating entries', 'TRUNCATE storage_recovery_plan_entries', [], /TRUNCATE is not allowed/],
    ] as const) {
      await assert.rejects(q(statement, [...params]), expected, label);
    }
    const reviewed = await reviewRecoveryPlan(deps(), { credential: cred.approver, planId: plan.id });
    assert.ok(reviewed.ok);
    assert.deepEqual([reviewed.plan.integrity, reviewed.plan.digest, reviewed.plan.entries], ['intact', plan.digest, plan.entries], 'unchanged');
    assert.equal(refusal(await revokeRecoveryPlan(deps(), { credential: cred.approver, planId: plan.id, reason: 'Test plan withdrawn' })), 'ok');
    await finish('immutable');
  });

  it('3. unauthorized approval is rejected: missing role, missing credential, the plan’s own creator, or an unapproved claim', async () => {
    await abandoned(1);
    const plan = await create();
    for (const [credential, expected] of [
      [cred.planner, 'not_authorized'],
      [cred.executor, 'not_authorized'],
      [undefined, 'identity_rejected'],
    ] as const) {
      assert.equal(refusal(await approveRecoveryPlan(deps(), { credential, planId: plan.id, digest: plan.digest })), expected);
    }
    // The creator cannot bypass approval: not by approving their own plan, even holding every role, nor by executing it.
    const own = await createRecoveryPlan(deps(), { credential: cred.lead });
    assert.ok(own.ok && own.plan);
    assert.equal(refusal(await approveRecoveryPlan(deps(), { credential: cred.lead, planId: own.plan.id, digest: own.plan.digest })), 'self_approval');
    assert.equal(refusal(await claimRecoveryPlan(deps(), { credential: cred.lead, planId: own.plan.id })), 'invalid_state');
    assert.equal(refusal(await claimRecoveryPlan(deps(), { credential: cred.executor, planId: plan.id })), 'invalid_state', 'nothing runs before approval');
    // Not even directly in the database.
    await assert.rejects(
      q(`UPDATE storage_recovery_plans SET status = 'approved', approved_by_issuer = created_by_issuer, approved_by_subject = created_by_subject, approved_at = now() WHERE id = $1`, [own.plan.id]),
      /storage_recovery_plans_separation_check/,
    );
    for (const id of [plan.id, own.plan.id]) assert.equal((await planRow(id)).status, 'awaiting_approval');
    const rejected = (await planEvents(plan.id)).filter((event) => event.action === 'storage.recovery_request_rejected').map((event) => [event.metadata.after.refusal, event.metadata.after.operator?.subject ?? null]);
    assert.deepEqual(rejected, [['not_authorized', OPS.planner], ['not_authorized', OPS.executor], ['identity_rejected', null], ['invalid_state', OPS.executor]], 'every rejection is audited');
    assert.equal(deletes().length, 0);
    for (const id of [plan.id, own.plan.id]) await revokeRecoveryPlan(deps(), { credential: cred.approver, planId: id, reason: 'Test plan withdrawn' });
    await finish('unauthorized');
  });

  it('4. a trusted operator’s approval is accepted and recorded with the verified identity', async () => {
    await abandoned(1);
    const plan = await create();
    const result = await approveRecoveryPlan(deps(), { credential: cred.approver, planId: plan.id, digest: plan.digest });
    assert.ok(result.ok);
    assert.equal(result.plan.status, 'approved');
    assert.deepEqual({ issuer: result.plan.approvedBy!.issuer, subject: result.plan.approvedBy!.subject }, { issuer: idp.issuer, subject: OPS.approver });
    const row = await planRow(plan.id);
    assert.deepEqual([row.approved_by_issuer, row.approved_by_subject, row.approved_at instanceof Date], [idp.issuer, OPS.approver, true]);
    assert.equal(refusal(await approveRecoveryPlan(deps(), { credential: cred.approver2, planId: plan.id, digest: plan.digest })), 'invalid_state', 'an approval is given once');
    assert.equal((await planEvents(plan.id)).find((event) => event.action === 'storage.recovery_plan_approved')!.metadata.after.operator.subject, OPS.approver);
    assert.equal((await run(plan.id)).status, 'completed');
    await finish('approval');
  });

  it('5. a caller-forged operator identity is rejected', async () => {
    await abandoned(1);
    const plan = await create();
    const [version, payload, signature] = cred.planner.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    const elevated = Buffer.from(JSON.stringify({ ...claims, sub: OPS.approver, roles: ['storage_recovery.approver'] })).toString('base64url');
    const other = testOperatorIdentity();
    const forged: Array<[string, unknown]> = [
      ['payload changed to another subject and role', `${version}.${elevated}.${signature}`],
      ['signed with another key', other.issue(OPS.approver, ['storage_recovery.approver'])],
      ['another issuer', idp.issue(OPS.approver, ['storage_recovery.approver'], { issuer: 'someone-else' })],
      ['another audience', idp.issue(OPS.approver, ['storage_recovery.approver'], { audience: 'another-service' })],
      ['expired', idp.issue(OPS.approver, ['storage_recovery.approver'], { ttlSeconds: -1 })],
      ['a plain operator name', OPS.approver],
      ['a caller-built identity object', { issuer: idp.issuer, subject: OPS.approver, roles: new Set(['storage_recovery.approver']) }],
      ['nothing', null],
    ];
    for (const [label, credential] of forged) {
      assert.equal(refusal(await approveRecoveryPlan(deps(), { credential, planId: plan.id, digest: plan.digest })), 'identity_rejected', label);
      assert.equal(refusal(await claimRecoveryPlan(deps(), { credential, planId: plan.id })), 'identity_rejected', label);
    }
    // Without a trusted provider (this build's production default), even a valid credential proves nothing.
    assert.equal(refusal(await approveRecoveryPlan(deps({ identity: NO_TRUSTED_OPERATOR_IDENTITY }), { credential: cred.approver, planId: plan.id, digest: plan.digest })), 'identity_rejected');
    assert.equal((await planRow(plan.id)).status, 'awaiting_approval');
    assert.equal((await planEvents(plan.id)).filter((event) => event.metadata.after.refusal === 'identity_rejected' && event.metadata.after.operator === null).length, forged.length * 2 + 1);
    await revokeRecoveryPlan(deps(), { credential: cred.approver, planId: plan.id, reason: 'Test plan withdrawn' });
    await finish('forged');
  });

  it('6. an approval quoting an invalid digest is rejected', async () => {
    await abandoned(1);
    const plan = await create();
    await abandoned(1);
    const another = await create();
    for (const digest of ['', 'a'.repeat(64), plan.digest.toUpperCase(), plan.digest.slice(0, 63), another.digest]) {
      assert.equal(refusal(await approveRecoveryPlan(deps(), { credential: cred.approver, planId: plan.id, digest })), 'digest_mismatch', digest);
    }
    assert.equal((await planRow(plan.id)).status, 'awaiting_approval');
    for (const id of [plan.id, another.id]) await revokeRecoveryPlan(deps(), { credential: cred.approver, planId: id, reason: 'Test plan withdrawn' });
    await finish('digest');
  });

  it('7. a plan modified after review cannot be approved, even with the digest of what was reviewed', async () => {
    const [key] = await abandoned(1);
    const plan = await create();
    await bypassTriggers(`UPDATE storage_recovery_plan_entries SET generation = '1' WHERE plan_id = $1`, [plan.id]);
    const reviewed = await reviewRecoveryPlan(deps(), { credential: cred.approver, planId: plan.id });
    assert.ok(reviewed.ok);
    assert.equal(reviewed.plan.integrity, 'mismatch', 'review shows the contents no longer match the digest');
    assert.equal(refusal(await approveRecoveryPlan(deps(), { credential: cred.approver, planId: plan.id, digest: plan.digest })), 'integrity_failure');
    assert.equal((await planRow(plan.id)).status, 'awaiting_approval');
    assert.ok((await files()).includes(key!));
    await revokeRecoveryPlan(deps(), { credential: cred.approver, planId: plan.id, reason: 'Tampered plan' });
    await finish('modified');
  });

  it('8. an expired plan cannot be approved, claimed or revoked; it is closed as expired', async () => {
    await abandoned(1);
    const plan = await create({ ttlSeconds: 1 });
    await sleep(1_200);
    assert.equal(refusal(await approveRecoveryPlan(deps(), { credential: cred.approver, planId: plan.id, digest: plan.digest })), 'expired');
    assert.equal((await planRow(plan.id)).status, 'expired');
    assert.equal(refusal(await claimRecoveryPlan(deps(), { credential: cred.executor, planId: plan.id })), 'expired');
    assert.equal(refusal(await revokeRecoveryPlan(deps(), { credential: cred.approver, planId: plan.id, reason: 'Too late' })), 'expired');
    // An approved plan expires too.
    const short = await approved({ ttlSeconds: 1 });
    await sleep(1_200);
    assert.equal(refusal(await claimRecoveryPlan(deps(), { credential: cred.executor, planId: short.id })), 'expired');
    assert.deepEqual((await planEvents(short.id)).map((event) => event.action).slice(-2), ['storage.recovery_plan_expired', 'storage.recovery_request_rejected']);
    await assert.rejects(q(`UPDATE storage_recovery_plans SET status = 'awaiting_approval' WHERE id = $1`, [plan.id]), /closed/);
    // A plan that expires during execution stops before its next deletion.
    await expireLeases();
    const running = await approved({ ttlSeconds: 2 });
    let delayed = false;
    const slow = wrapped({
      stat: async (key) => {
        if (!delayed && running.entries.some((entry) => entry.keyRef === keyRef(key))) {
          delayed = true;
          await sleep(2_200);
        }
        return store.stat(key);
      },
    });
    const report = await run(running.id, cred.executor, { store: slow });
    assert.deepEqual([report.status, report.stopReason, report.entries], ['stopped', 'expired', []]);
    assert.equal((await planRow(running.id)).status, 'expired');
    assert.equal(deletes().length, 0);
    await finish('expired');
  });

  it('9. a plan revoked before execution never runs', async () => {
    const [key] = await abandoned(1);
    const plan = await approved();
    assert.equal(refusal(await revokeRecoveryPlan(deps(), { credential: cred.approver2, planId: plan.id, reason: '  ' })), 'invalid_request', 'a reason is required');
    assert.equal(refusal(await revokeRecoveryPlan(deps(), { credential: cred.executor, planId: plan.id, reason: 'Not mine to revoke' })), 'not_authorized');
    const revoked = await revokeRecoveryPlan(deps(), { credential: cred.approver2, planId: plan.id, reason: 'Wrong maintenance window' });
    assert.ok(revoked.ok);
    assert.deepEqual([revoked.plan.status, revoked.plan.revokedBy!.subject, revoked.plan.revokedBy!.reason], ['revoked', OPS.approver2, 'Wrong maintenance window']);
    assert.equal(refusal(await claimRecoveryPlan(deps(), { credential: cred.executor, planId: plan.id })), 'revoked');
    assert.equal(refusal(await revokeRecoveryPlan(deps(), { credential: cred.approver, planId: plan.id, reason: 'Again' })), 'revoked');
    // Its creator may also withdraw a plan.
    const own = await create();
    assert.equal(refusal(await revokeRecoveryPlan(deps(), { credential: cred.planner, planId: own.id, reason: 'Withdrawn by its creator' })), 'ok');
    assert.equal(deletes().length, 0);
    assert.ok((await files()).includes(key!));
    assert.equal((await intents()).length, 1);
    await finish('revoked before');
  });

  it('10. a revocation during execution stops it: between entries (no transaction is held while storage is read), and after a deletion in progress commits', async () => {
    const keys = await abandoned(3);
    const plan = await approved();
    const keyOf = (entry: { keyRef: string }) => keys.find((key) => keyRef(key) === entry.keyRef)!;
    const second = keyOf(plan.entries[1]!);
    let openTransactions = -1;
    const revokingStore = wrapped({
      stat: async (key) => {
        if (key === second && openTransactions < 0) {
          openTransactions = Number((await q<{ n: string }>(`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'`))[0]!.n);
          assert.equal(refusal(await revokeRecoveryPlan(deps(), { credential: cred.approver2, planId: plan.id, reason: 'Stop the run' })), 'ok');
        }
        return store.stat(key);
      },
    });
    const report = await run(plan.id, cred.executor, { store: revokingStore });
    assert.equal(openTransactions, 0, 'no transaction was open while the object was being read');
    assert.deepEqual([report.status, report.stopReason, report.entries.map((entry) => [entry.keyRef, entry.outcome])], ['stopped', 'revoked', [[plan.entries[0]!.keyRef, 'file_removed']]]);
    assert.deepEqual((await entryRows(plan.id)).map((row) => row.state), ['done', 'pending', 'pending']);
    assert.deepEqual((await files()).filter((name) => keys.includes(name)).sort(), [keyOf(plan.entries[1]!), keyOf(plan.entries[2]!)].sort());

    // Revoked while a deletion is in flight: the revocation waits for that entry to commit, and nothing runs after it.
    await expireLeases();
    const plan2 = await approved();
    let revoking: Promise<{ ok: boolean }> | null = null;
    let revoked = false;
    let revokedBeforeDeletion: boolean | null = null;
    const slowDelete = wrapped({
      deleteGeneration: async (key, generation) => {
        if (!revoking) {
          revoking = revokeRecoveryPlan(deps(), { credential: cred.approver2, planId: plan2.id, reason: 'Stop now' });
          void revoking.then(() => (revoked = true));
          await sleep(500);
          revokedBeforeDeletion = revoked;
        }
        return store.deleteGeneration(key, generation);
      },
    });
    const report2 = await run(plan2.id, cred.executor, { store: slowDelete });
    assert.equal(revokedBeforeDeletion, false, 'the revocation waited for the deletion in progress');
    assert.equal(refusal(await revoking!), 'ok');
    assert.deepEqual([report2.stopReason, report2.entries.map((entry) => entry.outcome)], ['revoked', ['file_removed']]);
    assert.deepEqual((await entryRows(plan2.id)).map((row) => row.state), ['done', 'pending']);
    assert.equal((await planRow(plan2.id)).status, 'revoked');
    assert.equal((await intents()).length, 1);
    await finish('revoked during');
  });

  it('11. two workers competing for one plan: one claim wins, the other is refused, and a stale or forged claim deletes nothing', async () => {
    const keys = await abandoned(3);
    const plan = await approved();
    const claims = await Promise.all([cred.executor, cred.executor2, cred.executor].map((credential) => claimRecoveryPlan(deps(), { credential, planId: plan.id })));
    assert.deepEqual(claims.map(refusal).sort(), ['in_progress', 'in_progress', 'ok']);
    const winner = claims.find((claim) => claim.ok) as Extract<(typeof claims)[number], { ok: true }>;
    gcs.reset();
    const forged = await executeRecoveryPlan(deps(), { ...winner.claim, token: randomUUID() });
    assert.deepEqual([forged.stopReason, deletes().length], ['claim_lost', 0], 'a claim token it does not hold executes nothing');
    const [report, competitor] = await Promise.all([executeRecoveryPlan(deps(), winner.claim), claimRecoveryPlan(deps(), { credential: cred.executor2, planId: plan.id })]);
    assert.equal(report.status, 'completed');
    assert.ok(['in_progress', 'completed'].includes(refusal(competitor)));
    assert.deepEqual(deletes().map((request) => request.name).sort(), keys.sort(), 'each object deleted exactly once');

    // A worker whose claim lapsed was taken over: when it wakes up, it is fenced out.
    const keys2 = await abandoned(2);
    const plan2 = await approved();
    const first = await claimRecoveryPlan(deps(), { credential: cred.executor, planId: plan2.id, claimTtlSeconds: 1 });
    assert.ok(first.ok);
    await sleep(1_200);
    const second = await claimRecoveryPlan(deps(), { credential: cred.executor2, planId: plan2.id });
    assert.ok(second.ok && second.resumed);
    gcs.reset();
    const zombie = await executeRecoveryPlan(deps(), first.claim);
    assert.deepEqual([zombie.stopReason, zombie.entries, deletes().length], ['claim_lost', [], 0]);
    const report2 = await executeRecoveryPlan(deps(), second.claim);
    assert.deepEqual([report2.status, deletes().map((request) => request.name).sort()], ['completed', keys2.sort()]);
    await assertClean('competing');
  });

  it('12. a worker killed after claiming a plan: the claim lapses and another worker resumes it', async () => {
    await abandoned(2);
    const plan = await approved();
    const worker = child({ CRASH_MODE: 'approved-claim', CRASH_PAUSE: 'claimed:1', ...workerEnv(plan.id, 2) });
    await worker.paused();
    await worker.kill();
    const row = await planRow(plan.id);
    assert.deepEqual([row.status, row.claimed_by_subject], ['applying', OPS.executor]);
    assert.equal(refusal(await claimRecoveryPlan(deps(), { credential: cred.executor2, planId: plan.id })), 'in_progress', 'not while the claim is live');
    await sleep(2_100);
    const resumed = await claimRecoveryPlan(deps(), { credential: cred.executor2, planId: plan.id });
    assert.ok(resumed.ok && resumed.resumed);
    const report = await executeRecoveryPlan(deps(), resumed.claim);
    assert.deepEqual([report.status, outcomes(report)], ['completed', ['file_removed', 'file_removed']]);
    const events = (await planEvents(plan.id)).map((event) => [event.action, event.metadata.after.operator?.subject ?? event.metadata.after.executor?.subject, event.metadata.after.previousClaimant?.subject ?? event.metadata.after.refusal ?? null]);
    assert.deepEqual(events.slice(-4), [
      ['storage.recovery_plan_claimed', OPS.executor, null],
      ['storage.recovery_request_rejected', OPS.executor2, 'in_progress'],
      ['storage.recovery_plan_resumed', OPS.executor2, OPS.executor],
      ['storage.recovery_plan_completed', OPS.executor2, null],
    ]);
    await assertClean('crash after claim');
  });

  it('13. a worker killed after deleting an object, before recording it: the entry rolled back, and resuming finishes it', async () => {
    const [key] = await abandoned(1);
    const plan = await approved();
    let deleted!: () => void;
    const wasDeleted = new Promise<void>((resolve) => (deleted = resolve));
    // After the object is deleted, its verification hangs: the worker is killed inside its transaction.
    gcs.onDelete = (name) => {
      gcs.faults.set(name, 'hang');
      deleted();
    };
    const worker = child({ CRASH_MODE: 'approved-run', ...workerEnv(plan.id, 2) });
    await wasDeleted;
    await worker.kill();
    gcs.reset();
    assert.ok(!(await files()).includes(key!), 'the object was deleted');
    assert.deepEqual((await intents()).map((row) => row.storage_key), [key], 'its journal entry rolled back');
    assert.deepEqual((await entryRows(plan.id)).map((row) => row.state), ['pending'], 'and so did its plan entry');
    assert.equal((await q(`SELECT 1 FROM audit_log WHERE action = 'storage.write_recovered' AND entity_id = $1`, [plan.entries[0]!.intentId])).length, 0);
    assert.equal((await planRow(plan.id)).status, 'applying');
    await sleep(2_100);
    const resumed = await runRecoveryPlan(deps(), { credential: cred.executor2, planId: plan.id });
    assert.ok(resumed.ok && resumed.resumed);
    assert.deepEqual([resumed.report.status, outcomes(resumed.report)], ['completed', ['file_already_missing']]);
    assert.equal(refusal(await claimRecoveryPlan(deps(), { credential: cred.executor, planId: plan.id })), 'completed');
    await assertClean('crash after deletion');
  });

  it('14. a failed operation is kept for inspection and retried by resuming the plan', async () => {
    const [failing, fine] = await abandoned(2);
    const plan = await approved();
    gcs.faults.set(failing!, 'unavailable');
    const first = await run(plan.id);
    assert.deepEqual([first.status, first.entries.map((entry) => [entry.outcome, entry.errorCode ?? null, entry.final ?? null]).sort()], [
      'partially_completed',
      [
        ['failed', 'UNAVAILABLE', false],
        ['file_removed', null, null],
      ],
    ]);
    const row = await planRow(plan.id);
    assert.deepEqual([row.status, row.claim_token], ['partially_completed', null]);
    const failedEntry = (await entryRows(plan.id)).find((entry) => entry.state === 'failed')!;
    assert.deepEqual([failedEntry.error_code, failedEntry.attempts], ['UNAVAILABLE', 1]);
    assert.deepEqual((await intents()).map((intent) => [intent.storage_key, intent.attempts, intent.last_error]), [[failing, 1, 'UNAVAILABLE']]);
    assert.ok((await files()).includes(failing!) && !(await files()).includes(fine!));
    // Storage that cannot be read, or that shows none of the documents' files, is not trusted: nothing is planned or claimed.
    const blind = wrapped({ stat: async () => ({ state: 'missing' as const }) });
    gcs.faults.set('*', 'unavailable');
    for (const [overrides, expected] of [
      [{}, 'storage_error'],
      [{ store: blind }, 'storage_unverified'],
    ] as const) {
      assert.equal(refusal(await createRecoveryPlan(deps(overrides), { credential: cred.planner })), expected);
      assert.equal(refusal(await claimRecoveryPlan(deps(overrides), { credential: cred.executor, planId: plan.id })), expected);
    }
    assert.equal((await planRow(plan.id)).status, 'partially_completed');
    gcs.reset();
    const retried = await runRecoveryPlan(deps(), { credential: cred.executor, planId: plan.id });
    assert.ok(retried.ok && retried.resumed);
    assert.deepEqual([retried.report.status, retried.report.entries.map((entry) => entry.outcome)], ['completed', ['file_removed']], 'only the failed entry is retried');
    assert.deepEqual(deletes().map((request) => request.name), [failing]);
    await assertClean('retry');
  });

  it('15. an object whose generation changed is never deleted, whether it changed before or during the deletion', async () => {
    const [key] = await abandoned(1);
    const plan = await approved();
    await rewrite(key!);
    const changed = await generationOf(join(storageDir, key!));
    gcs.reset();
    const report = await run(plan.id);
    assert.deepEqual(report.entries.map((entry) => [entry.outcome, entry.errorCode, entry.final]), [['failed', 'GENERATION_CHANGED', true]]);
    assert.equal(deletes().length, 0, 'a replaced object is not even asked to be deleted');
    assert.equal(await generationOf(join(storageDir, key!)), changed);
    assert.deepEqual([(await planRow(plan.id)).status, (await entryRows(plan.id))[0]!.state], ['completed', 'failed_final'], 'only a new plan can act on it');
    assert.deepEqual((await intents()).map((intent) => [intent.attempts, intent.last_error]), [[1, 'GENERATION_CHANGED']]);
    // Replaced between the check and the deletion: the generation precondition refuses it (412).
    const plan2 = await approved();
    const racing = wrapped({
      deleteGeneration: async (k, generation) => {
        await rewrite(k);
        return store.deleteGeneration(k, generation);
      },
    });
    const report2 = await run(plan2.id, cred.executor, { store: racing });
    assert.deepEqual(report2.entries.map((entry) => [entry.errorCode, entry.final]), [['GENERATION_CHANGED', true]]);
    assert.ok((await files()).includes(key!), 'the newer object is still there');
    // A deletion the store does not reflect: the entry is kept and flagged, never forgotten.
    const plan3 = await approved();
    gcs.faults.set(key!, 'ignore_delete');
    const report3 = await run(plan3.id);
    assert.deepEqual(report3.entries.map((entry) => [entry.errorCode, entry.final]), [['STILL_PRESENT', true]]);
    assert.deepEqual((await intents()).map((intent) => intent.last_error), ['STILL_PRESENT']);
    await finish('generation');
  });

  it('16. a lease renewed after approval makes its entry ineligible for deletion', async () => {
    const [key] = await abandoned(1);
    const plan = await approved();
    await q(`UPDATE document_storage_intents SET lease_expires_at = now() + interval '30 minutes'`);
    gcs.reset();
    const report = await run(plan.id);
    assert.deepEqual([report.status, outcomes(report), deletes().length], ['completed', ['skipped_lease_active'], 0]);
    assert.ok((await files()).includes(key!));
    assert.equal((await intents()).length, 1, 'the writer keeps its journal entry');
    await finish('lease');
  });

  it('17. a referenced document is never deleted, including one that becomes referenced after approval', async () => {
    const kept = await uploadDocument();
    const bytes = await readFile(join(storageDir, kept));
    await q(`INSERT INTO document_storage_intents (storage_key, operation, operation_id, lease_expires_at) VALUES ($1, 'document_upload', gen_random_uuid(), now() - interval '1 hour')`, [kept]);
    const [other] = await abandoned(1);
    const plan = await approved();
    assert.deepEqual(plan.entries.map((entry) => entry.action).sort(), ['delete', 'forget_referenced']);
    const [added] = await q<{ id: string }>(
      `INSERT INTO course_documents (activity_id, storage_key, file_name, format, byte_size, sha256, extraction_status, extraction_detail, segments, character_count, truncated, malware_scan_status, malware_scanner, uploaded_by_user_id)
       SELECT activity_id, $1, file_name, format, byte_size, sha256, extraction_status, extraction_detail, segments, character_count, truncated, malware_scan_status, malware_scanner, uploaded_by_user_id
       FROM course_documents WHERE storage_key = $2 RETURNING id`,
      [other, kept],
    );
    gcs.reset();
    const report = await run(plan.id);
    assert.deepEqual(outcomes(report), ['file_kept_referenced', 'skipped_now_referenced']);
    assert.equal(deletes().length, 0);
    assert.deepEqual(await readFile(join(storageDir, kept)), bytes, 'the document file is intact');
    assert.ok((await files()).includes(other!), 'the newly referenced file is intact');
    await q('DELETE FROM course_documents WHERE id = $1', [added!.id]);
    await finish('referenced');
  });

  it('18. an approval never crosses databases, environments, endpoints, buckets or prefixes', async () => {
    const [key] = await abandoned(1);
    const plan = await create();
    const otherApi = await startFakeGcs({ bucket: BUCKET, dir: storageDir });
    try {
      const elsewhere: Array<[string, Partial<RecoveryDeps>, string]> = [
        ['another database', { database: 'other-host:5432/other' }, 'wrong_environment'],
        ['another environment', { environment: 'staging' }, 'wrong_environment'],
        ['another endpoint', { store: new GcsJsonObjectStore({ bucket: BUCKET, baseUrl: otherApi.url, getAccessToken: async () => 'local-emulator' }) }, 'wrong_environment'],
        ['another bucket', { store: new GcsJsonObjectStore({ bucket: 'ap-other-bucket', baseUrl: gcs.url, getAccessToken: async () => 'local-emulator' }) }, 'wrong_bucket'],
        ['another prefix', { store: new GcsJsonObjectStore({ bucket: BUCKET, baseUrl: gcs.url, prefix: 'elsewhere/', getAccessToken: async () => 'local-emulator' }) }, 'wrong_bucket'],
      ];
      for (const [label, overrides, expected] of elsewhere) {
        assert.equal(refusal(await approveRecoveryPlan(deps(overrides), { credential: cred.approver, planId: plan.id, digest: plan.digest })), expected, `approve: ${label}`);
      }
      await approve(plan);
      gcs.reset();
      for (const [label, overrides, expected] of elsewhere) {
        assert.equal(refusal(await claimRecoveryPlan(deps(overrides), { credential: cred.executor, planId: plan.id })), expected, `claim: ${label}`);
      }
      assert.equal(otherApi.requests.length, 0, 'the other API was never called');
      const claimed = await claimRecoveryPlan(deps(), { credential: cred.executor, planId: plan.id });
      assert.ok(claimed.ok);
      for (const [label, overrides, expected] of elsewhere) {
        assert.equal((await executeRecoveryPlan(deps(overrides), claimed.claim)).stopReason, expected, `execute: ${label}`);
      }
      assert.equal(deletes().length, 0);
      assert.ok((await files()).includes(key!));
      assert.equal((await executeRecoveryPlan(deps(), claimed.claim)).status, 'completed');
    } finally {
      await otherApi.close();
    }
    await assertClean('binding');
  });

  it('19. an approval never authorizes entries that were not in the plan', async () => {
    const [planned] = await abandoned(1);
    const plan = await approved();
    const [later] = await abandoned(1);
    await assert.rejects(
      q(`INSERT INTO storage_recovery_plan_entries (plan_id, intent_id, operation, key_ref, action, generation) SELECT $1, id, operation, $2, 'delete', '1' FROM document_storage_intents WHERE storage_key = $3`, [plan.id, keyRef(later!), later]),
      /only be added/,
    );
    gcs.reset();
    const report = await run(plan.id);
    assert.deepEqual(report.entries.map((entry) => [entry.keyRef, entry.outcome]), [[keyRef(planned!), 'file_removed']]);
    assert.deepEqual(deletes().map((request) => request.name), [planned]);
    assert.ok((await files()).includes(later!), 'the later file was not touched');
    // Bypassing the triggers to add an entry to an approved plan: it no longer matches its digest and cannot run.
    const plan2 = await approved();
    const [extra] = await abandoned(1);
    await bypassTriggers(
      `INSERT INTO storage_recovery_plan_entries (plan_id, intent_id, operation, key_ref, action, generation) SELECT $1, id, operation, $2, 'delete', '1' FROM document_storage_intents WHERE storage_key = $3`,
      [plan2.id, keyRef(extra!), extra],
    );
    gcs.reset();
    assert.equal(refusal(await claimRecoveryPlan(deps(), { credential: cred.executor, planId: plan2.id })), 'integrity_failure');
    assert.equal(deletes().length, 0);
    assert.ok((await files()).includes(extra!) && (await files()).includes(later!));
    await revokeRecoveryPlan(deps(), { credential: cred.approver, planId: plan2.id, reason: 'Tampered plan' });
    await finish('additional entries');
  });

  it('20. a completed plan cannot be executed again destructively', async () => {
    await abandoned(1);
    const plan = await approved();
    const claimed = await claimRecoveryPlan(deps(), { credential: cred.executor, planId: plan.id });
    assert.ok(claimed.ok);
    assert.equal((await executeRecoveryPlan(deps(), claimed.claim)).status, 'completed');
    gcs.reset();
    assert.equal(refusal(await claimRecoveryPlan(deps(), { credential: cred.executor2, planId: plan.id })), 'completed');
    const again = await executeRecoveryPlan(deps(), claimed.claim);
    assert.deepEqual([again.status, again.entries, deletes().length], ['stopped', [], 0]);
    assert.equal(refusal(await approveRecoveryPlan(deps(), { credential: cred.approver2, planId: plan.id, digest: plan.digest })), 'completed');
    assert.equal(refusal(await revokeRecoveryPlan(deps(), { credential: cred.approver2, planId: plan.id, reason: 'After the fact' })), 'completed');
    await assert.rejects(q(`UPDATE storage_recovery_plans SET status = 'applying' WHERE id = $1`, [plan.id]), /closed/);
    await assert.rejects(q(`UPDATE storage_recovery_plan_entries SET state = 'pending' WHERE plan_id = $1`, [plan.id]), /only while|finished/);
    await assertClean('completed');
  });

  it('21. the audit history is complete, attributed to verified identities, append-only, and holds no storage key', async () => {
    const [key] = await abandoned(1);
    const plan = await approved();
    await run(plan.id);
    const events = await planEvents(plan.id);
    assert.deepEqual(
      events.map((event) => [event.action, event.metadata.after.operator?.subject ?? event.metadata.after.executor?.subject]),
      [
        ['storage.recovery_plan_created', OPS.planner],
        ['storage.recovery_plan_approved', OPS.approver],
        ['storage.recovery_plan_claimed', OPS.executor],
        ['storage.recovery_plan_completed', OPS.executor],
      ],
    );
    assert.ok(events.every((event) => !('digest' in event.metadata.after) || event.metadata.after.digest === plan.digest));
    const [recovered] = await q<{ metadata: Record<string, any> }>(`SELECT metadata FROM audit_log WHERE action = 'storage.write_recovered' AND entity_id = $1`, [plan.entries[0]!.intentId]);
    assert.deepEqual([recovered!.metadata.after.planId, recovered!.metadata.after.planDigest, recovered!.metadata.after.generation], [plan.id, plan.digest, plan.entries[0]!.generation]);
    await assert.rejects(q(`DELETE FROM audit_log WHERE entity_id = $1`, [plan.id]), /append-only/);
    await assert.rejects(q(`UPDATE audit_log SET metadata = '{}' WHERE entity_id = $1`, [plan.id]), /append-only/);
    await assert.rejects(q(`DELETE FROM storage_recovery_plans WHERE id = $1`, [plan.id]), /permanent/);
    const recorded = [
      ...(await q<{ text: string }>(`SELECT metadata::text AS text FROM audit_log WHERE action LIKE 'storage.%'`)),
      ...(await q<{ text: string }>('SELECT row_to_json(p)::text AS text FROM storage_recovery_plans p')),
      ...(await q<{ text: string }>('SELECT row_to_json(e)::text AS text FROM storage_recovery_plan_entries e')),
    ].map((row) => row.text);
    assert.ok(allKeys.has(key!) && allKeys.size > 10);
    for (const storageKey of allKeys) assert.ok(!recorded.some((text) => text.includes(storageKey)), 'no storage key in any plan, entry or audit record');
    await assertClean('audit');
  });

  it('22. production execution remains blocked', async () => {
    const [key] = await abandoned(1);
    const plan = await approved();
    gcs.reset();
    let realApiCalls = 0;
    const real = new GcsJsonObjectStore({ bucket: BUCKET, getAccessToken: async () => 'unused', fetch: (async () => ((realApiCalls += 1), new Response(null, { status: 503 }))) as typeof fetch });
    assert.equal(refusal(await createRecoveryPlan(deps({ store: real }), { credential: cred.planner })), 'production_disabled');
    assert.equal(refusal(await claimRecoveryPlan(deps({ store: real }), { credential: cred.executor, planId: plan.id })), 'production_disabled');
    assert.equal((await previewRecovery({ db: database.db, store: real })).refusal, 'production_disabled');
    for (const [name, value] of [
      ['NODE_ENV', 'production'],
      ['K_SERVICE', 'academiapath-api'],
      ['CLOUD_RUN_JOB', 'academiapath-storage-recover'],
    ] as const) {
      const saved = process.env[name];
      process.env[name] = value;
      try {
        assert.equal(refusal(await createRecoveryPlan(deps(), { credential: cred.planner })), 'production_disabled', name);
        assert.equal(refusal(await claimRecoveryPlan(deps(), { credential: cred.executor, planId: plan.id })), 'production_disabled', name);
      } finally {
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
      }
    }
    // A claim made locally cannot be executed in production either.
    const claimed = await claimRecoveryPlan(deps(), { credential: cred.executor, planId: plan.id });
    assert.ok(claimed.ok);
    process.env.K_SERVICE = 'academiapath-api';
    try {
      assert.equal((await executeRecoveryPlan(deps(), claimed.claim)).stopReason, 'production_disabled');
    } finally {
      delete process.env.K_SERVICE;
    }
    assert.equal(realApiCalls, 0, 'the real Cloud Storage API was never called');
    assert.equal(deletes().length, 0);
    assert.ok((await files()).includes(key!));
    // This build has no trusted identity provider: nothing can be planned, approved or run with it.
    const untrusted = deps({ identity: NO_TRUSTED_OPERATOR_IDENTITY });
    assert.equal(refusal(await createRecoveryPlan(untrusted, { credential: cred.planner })), 'identity_rejected');
    assert.equal(refusal(await runRecoveryPlan(untrusted, { credential: cred.executor, planId: plan.id })), 'identity_rejected');
    // The command only previews, and only locally.
    const quiet = async (run: () => Promise<number>) => {
      const { log, error } = console;
      console.log = () => undefined;
      console.error = () => undefined;
      try {
        return await run();
      } finally {
        console.log = log;
        console.error = error;
      }
    };
    const env = { DATABASE_URL: database.url } as NodeJS.ProcessEnv;
    const args = ['--bucket', BUCKET, '--api-url', gcs.url];
    gcs.reset();
    for (const [label, argv, environment] of [
      ['production', ['preview', ...args], { ...env, NODE_ENV: 'production' }],
      ['Cloud Run service', ['preview', ...args], { ...env, K_SERVICE: 'academiapath-api' }],
      ['Cloud Run job', ['preview', ...args], { ...env, CLOUD_RUN_JOB: 'academiapath-storage-recover' }],
      ['remote database', ['preview', ...args], { DATABASE_URL: 'postgresql://user@db.example.com:5432/app' }],
      ['real Cloud Storage API', ['preview', '--bucket', BUCKET, '--api-url', 'https://storage.googleapis.com'], env],
      ['remote emulator', ['preview', '--bucket', BUCKET, '--api-url', 'http://10.0.0.5:4443'], env],
      ['digest-only apply (removed)', ['apply', ...args, '--plan', 'plan.json', '--approve', plan.digest], env],
      ['file plan (removed)', ['plan', ...args, '--out', join(root, 'plan.json')], env],
    ] as const) {
      assert.equal(await quiet(() => approvedCli([...argv], environment)), APPROVED_EXIT.refused, label);
    }
    assert.equal(gcs.requests.length, 0, 'no storage request was made');
    const output: string[] = [];
    const { log } = console;
    console.log = (line: string) => output.push(line);
    try {
      assert.equal(await approvedCli(['preview', ...args], env), APPROVED_EXIT.pending);
    } finally {
      console.log = log;
    }
    assert.ok(!output.join('\n').includes(key!), 'the preview shows no storage key');
    assert.ok(gcs.requests.every((request) => request.method === 'GET'));
    assert.equal((await planRow(plan.id)).status, 'applying', 'the preview changed nothing');
    assert.equal((await executeRecoveryPlan(deps(), claimed.claim)).status, 'completed');
    await assertClean('production');
  });
});

describe('migration 0038 on existing data (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let previous: Awaited<ReturnType<typeof migrationsBefore>> | undefined;
  let root: string;
  let gcs: FakeGcs;

  before(async () => {
    previous = await migrationsBefore('0038_storage_recovery_approvals');
    database = await createTestDatabase({ migrationsFolder: previous.folder });
    root = await mkdtemp(join(tmpdir(), 'ap-recovery-upgrade-'));
    gcs = await startFakeGcs({ bucket: BUCKET, dir: root });
  });
  after(async () => {
    await gcs?.close();
    await database?.drop();
    await previous?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('applies on top of journaled writes, keeps them, and recovery plans work on the upgraded database', async () => {
    const q = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await database.pool.query<T>(text, params)).rows;
    assert.equal((await q<{ n: number }>('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations'))[0]!.n, 38, 'migrations 0000–0037');
    await q(`INSERT INTO document_storage_intents (storage_key, operation, operation_id, lease_expires_at, attempts, last_error) VALUES
      (gen_random_uuid(), 'archive_import', gen_random_uuid(), now() - interval '2 hours', 2, 'EIO'),
      (gen_random_uuid(), 'document_upload', gen_random_uuid(), now() + interval '20 minutes', 0, NULL)`);
    const journal = await q('SELECT * FROM document_storage_intents ORDER BY operation');
    await migrate(database.db, { migrationsFolder });
    assert.equal((await q<{ n: number }>('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations'))[0]!.n, 39, 'migrations 0000–0038');
    assert.deepEqual(await q('SELECT * FROM document_storage_intents ORDER BY operation'), journal, 'existing journal entries unchanged');
    assert.deepEqual(
      (await q<{ tgname: string }>(`SELECT tgname FROM pg_trigger WHERE tgrelid IN ('storage_recovery_plans'::regclass, 'storage_recovery_plan_entries'::regclass) AND NOT tgisinternal ORDER BY tgname`)).map((row) => row.tgname),
      ['storage_recovery_plan_entries_guard', 'storage_recovery_plan_entries_no_truncate', 'storage_recovery_plans_guard', 'storage_recovery_plans_no_truncate'],
    );
    const idp = testOperatorIdentity();
    const store = new GcsJsonObjectStore({ bucket: BUCKET, baseUrl: gcs.url, getAccessToken: async () => 'local-emulator', timeoutMs: 400 });
    const deps: RecoveryDeps = { db: database.db, store, identity: idp.provider, database: DATABASE_ID, environment: ENVIRONMENT };
    const created = await createRecoveryPlan(deps, { credential: idp.issue(OPS.planner, ['storage_recovery.planner']) });
    assert.ok(created.ok && created.plan);
    assert.deepEqual([created.plan.entries.map((entry) => [entry.operation, entry.action]), created.plan.summary.counts.active], [[['archive_import', 'forget_missing']], 1]);
    const approvedPlan = await approveRecoveryPlan(deps, { credential: idp.issue(OPS.approver, ['storage_recovery.approver']), planId: created.plan.id, digest: created.plan.digest });
    assert.ok(approvedPlan.ok);
    const ran = await runRecoveryPlan(deps, { credential: idp.issue(OPS.executor, ['storage_recovery.executor']), planId: created.plan.id });
    assert.ok(ran.ok);
    assert.deepEqual([ran.report.status, outcomes(ran.report)], ['completed', ['file_already_missing']]);
    assert.deepEqual((await q<{ operation: string }>('SELECT operation FROM document_storage_intents')).map((row) => row.operation), ['document_upload'], 'the active write is untouched');
  });
});
