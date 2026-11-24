/**
 * AP-OPS-02: the Cloud Storage JSON API adapter used by approved storage recovery, against a simulated API
 * (test/helpers/fake-gcs.ts) backed by a temporary directory. No database, no real Cloud Storage, synthetic files.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { GcsJsonObjectStore, metadataServerToken, ObjectStoreError, type ObjectStoreErrorKind } from '../../src/documents/object-store.js';
import { generationOf, startFakeGcs, type FakeGcs } from '../helpers/fake-gcs.js';

const BUCKET = 'ap-test-documents';

describe('Cloud Storage JSON API adapter (AP-OPS-02, simulated API)', () => {
  let dir: string;
  let gcs: FakeGcs;
  const store = (options: Partial<ConstructorParameters<typeof GcsJsonObjectStore>[0]> = {}) =>
    new GcsJsonObjectStore({ bucket: BUCKET, baseUrl: gcs.url, getAccessToken: async () => 'test-token', timeoutMs: 300, ...options });
  const object = async (content = 'synthetic file') => {
    const key = randomUUID();
    await writeFile(join(dir, key), content);
    return key;
  };
  const rejectsWith = (promise: Promise<unknown>, kind: ObjectStoreErrorKind) => assert.rejects(promise, (error: unknown) => error instanceof ObjectStoreError && error.kind === kind, kind);

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ap-object-store-'));
    gcs = await startFakeGcs({ bucket: BUCKET, dir });
  });
  after(async () => {
    await gcs.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('reads only metadata, with credentials, and reports present (with the exact generation) or missing', async () => {
    gcs.reset();
    const key = await object();
    assert.deepEqual(await store().stat(key), { state: 'present', generation: await generationOf(join(dir, key)), size: 14 });
    assert.deepEqual(await store().stat(randomUUID()), { state: 'missing' });
    assert.ok(gcs.requests.every((request) => request.method === 'GET' && request.authorized && request.bucket === BUCKET && request.name !== null));
    assert.ok(gcs.requests.every((request) => request.query.fields === 'bucket,name,generation,size' && request.query.alt === undefined), 'metadata only, never the content');
  });

  it('deletes only the exact generation, and says so when it is already gone', async () => {
    gcs.reset();
    const key = await object();
    const generation = await generationOf(join(dir, key));
    await rejectsWith(store().deleteGeneration(key, '1234'), 'precondition_failed');
    assert.ok((await readdir(dir)).includes(key), 'another generation is never deleted');
    assert.equal(await store().deleteGeneration(key, generation), 'deleted');
    assert.ok(!(await readdir(dir)).includes(key));
    assert.equal(await store().deleteGeneration(key, generation), 'already_gone');
    assert.ok(gcs.requests.filter((request) => request.method === 'DELETE').every((request) => /^[1-9]\d*$/.test(request.query.ifGenerationMatch ?? '')), 'every delete carries the generation precondition');
  });

  it('never takes a failure for "missing": permission, timeout, unavailable and bad answers are distinct errors', async () => {
    const key = await object();
    const cases: Array<[Parameters<FakeGcs['faults']['set']>[1], ObjectStoreErrorKind]> = [
      ['forbidden', 'permission_denied'],
      ['unauthorized', 'permission_denied'],
      ['unavailable', 'unavailable'],
      ['hang', 'timeout'],
      ['reset', 'unavailable'],
      ['garbage', 'error'],
      ['wrong_name', 'error'],
    ];
    for (const [fault, kind] of cases) {
      gcs.reset();
      gcs.faults.set('*', fault);
      await rejectsWith(store().stat(key), kind);
    }
    gcs.reset();
    await rejectsWith(store({ getAccessToken: async () => Promise.reject(new Error('no token')) }).stat(key), 'permission_denied');
    const down = await startFakeGcs({ bucket: BUCKET, dir });
    const url = down.url;
    await down.close();
    await rejectsWith(store({ baseUrl: url }).stat(key), 'unavailable');
    gcs.faults.set('*', 'forbidden');
    await rejectsWith(store().deleteGeneration(key, await generationOf(join(dir, key))), 'permission_denied');
    gcs.reset();
    assert.ok((await readdir(dir)).includes(key), 'nothing was deleted');
  });

  it('stays inside its bucket and its key namespace', async () => {
    gcs.reset();
    for (const bad of ['../etc/passwd', 'a/b', 'not-a-key', `${randomUUID()}.pdf`, '00000000-0000-1000-8000-000000000000']) {
      await rejectsWith(store().stat(bad), 'invalid_key');
      await rejectsWith(store().deleteGeneration(bad, '1'), 'invalid_key');
    }
    assert.equal(gcs.requests.length, 0, 'no request for a key outside the namespace');
    for (const bucket of ['', 'UPPER', 'a', 'x/y', '../b']) assert.throws(() => store({ bucket }), /Invalid bucket/);
    for (const baseUrl of ['https://user:pass@storage.googleapis.com', 'https://storage.googleapis.com/other', 'https://storage.googleapis.com/?x=1']) assert.throws(() => store({ baseUrl }), /Invalid storage API URL/);
    // Another configured bucket reaches only that bucket (the simulator holds one: the others do not exist).
    const key = await object();
    assert.deepEqual(await store({ bucket: 'ap-other-bucket' }).stat(key), { state: 'missing' });
    assert.deepEqual([...new Set(gcs.requests.map((request) => request.bucket))], ['ap-other-bucket']);
    // A fixed prefix is part of the namespace.
    gcs.reset();
    await store({ prefix: 'documents/' }).stat(key);
    assert.equal(gcs.requests[0]!.name, `documents/${key}`);
    assert.throws(() => store({ prefix: '../' }), /Invalid object prefix/);
  });

  it('gets a token from the Cloud Run metadata server with its required header', async () => {
    let header: string | undefined;
    const metadata = createServer((req, res) => {
      header = req.headers['metadata-flavor'] as string | undefined;
      res.writeHead(header === 'Google' ? 200 : 403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'from-metadata', expires_in: 3599, token_type: 'Bearer' }));
    });
    await new Promise<void>((resolve) => metadata.listen(0, '127.0.0.1', resolve));
    try {
      const address = metadata.address() as { port: number };
      assert.equal(await metadataServerToken({ baseUrl: `http://127.0.0.1:${address.port}` })(), 'from-metadata');
      assert.equal(header, 'Google');
    } finally {
      metadata.close();
    }
    await assert.rejects(metadataServerToken({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 300 })());
  });
});
