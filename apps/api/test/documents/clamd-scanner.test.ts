/**
 * AP-040E: the ClamAV (clamd) adapter, the scan enforcement policy and their configuration, against a synthetic clamd
 * daemon (test/helpers/fake-clamd.ts) on a loopback port or a Unix socket. No database, no real malware: the only
 * "threat" is the plain-text part of the EICAR antivirus test string.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { ClamdScanner, parseClamdReply, type ClamdOptions } from '../../src/documents/clamd.js';
import { decideScan, type MalwareScanResult, type ScanEnforcement } from '../../src/documents/scanner.js';
import { makeDocx, makePdf, makePptx } from '../helpers/documents.js';
import { EICAR_MARKER_TEXT, FAKE_SIGNATURE, startFakeClamd, type FakeClamd } from '../helpers/fake-clamd.js';
import { exactPdf } from '../helpers/uploads.js';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const FILE = { fileName: 'handout.pdf', format: 'pdf' as const };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('clamd adapter (AP-040E, synthetic daemon)', () => {
  let daemon: FakeClamd;
  let root: string;
  const scanner = (options: Partial<ClamdOptions> = {}) =>
    new ClamdScanner({ endpoint: { host: '127.0.0.1', port: daemon.port }, timeoutMs: 2_000, maxBytes: 5 * 1024 * 1024, maxConcurrent: 2, ...options });
  const clean = makePdf([['Synthetic handout', 'Nothing to see here.']]);
  const infected = makePdf([['Synthetic handout', `Test marker ${EICAR_MARKER_TEXT} inside.`]]);

  before(async () => {
    daemon = await startFakeClamd();
    root = await mkdtemp(join(tmpdir(), 'ap-clamd-'));
  });
  after(async () => {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  });

  it('a clean file is clean only after the daemon received the complete file, in chunks', async () => {
    daemon.reset();
    const large = exactPdf(300_000);
    assert.deepEqual(await scanner().scan(large), { status: 'clean', scanner: 'clamd' });
    assert.deepEqual(daemon.streams, [{ bytes: large.length, sha256: sha256(large) }], 'every byte, in order');
    for (const document of [makeDocx(['Synthetic notes.']), makePptx([['Synthetic slide']])]) {
      assert.equal((await scanner().scan(document)).status, 'clean', 'DOCX and PPTX are sent as they are');
    }
  });

  it('an infected file is infected, with the signature name', async () => {
    daemon.reset();
    assert.deepEqual(await scanner().scan(infected), { status: 'infected', scanner: 'clamd', signature: FAKE_SIGNATURE });
  });

  it('an unreachable daemon is unavailable, never clean', async () => {
    const closed = await startFakeClamd();
    const port = closed.port;
    await closed.close();
    assert.deepEqual(await scanner({ endpoint: { host: '127.0.0.1', port } }).scan(clean), { status: 'unavailable', scanner: 'clamd', reason: 'connect_failed' });
    assert.deepEqual(await scanner({ endpoint: { socketPath: join(root, 'missing.sock') } }).scan(clean), { status: 'unavailable', scanner: 'clamd', reason: 'connect_failed' });
  });

  it('a daemon that never answers times out at the deadline, and the connection is closed', async () => {
    daemon.reset();
    daemon.behaviour = 'hang';
    const started = Date.now();
    assert.deepEqual(await scanner({ timeoutMs: 300 }).scan(clean), { status: 'timeout', scanner: 'clamd', reason: 'deadline' });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 280 && elapsed < 1_500, `timed out after ${elapsed} ms`);
    for (let i = 0; i < 50 && daemon.active > 0; i += 1) await sleep(10);
    assert.equal(daemon.active, 0, 'the client closed the connection');
  });

  it('a connection cut mid-stream or before the answer is an interruption, never clean', async () => {
    for (const behaviour of ['close_mid_stream', 'close_before_reply'] as const) {
      daemon.reset();
      daemon.behaviour = behaviour;
      assert.deepEqual(await scanner().scan(exactPdf(200_000)), { status: 'error', scanner: 'clamd', reason: 'interrupted' }, behaviour);
    }
  });

  it('anything but an exact verdict is an invalid response, never clean', async () => {
    const replies: Array<FakeClamd['behaviour']> = [
      { reply: 'HELLO' },
      { reply: 'OK' },
      { reply: 'stream: OK and more' },
      { reply: 'stream:OK' },
      { reply: '1: stream: OK' },
      { reply: 'stream:  FOUND' },
      'partial_reply',
      'long_reply',
    ];
    for (const behaviour of replies) {
      daemon.reset();
      daemon.behaviour = behaviour;
      const result = await scanner().scan(clean);
      assert.notEqual(result.status, 'clean', JSON.stringify(behaviour));
      assert.equal(result.status, 'error', JSON.stringify(behaviour));
    }
    // A "signature" named OK is a detection, never a clean verdict.
    daemon.reset();
    daemon.behaviour = { reply: 'stream: OK FOUND' };
    assert.equal((await scanner().scan(clean)).status, 'infected');
  });

  it('the daemon’s own errors and scan limits are errors with a reason', async () => {
    const cases: Array<[string, string]> = [
      ["Can't allocate memory ERROR", 'scanner_error'],
      ['INSTREAM size limit exceeded. ERROR', 'file_too_large'],
      ['stream: Heuristics.Limits.Exceeded.MaxScanSize FOUND', 'limits_exceeded'],
    ];
    for (const [reply, reason] of cases) {
      daemon.reset();
      daemon.behaviour = { reply };
      assert.deepEqual(await scanner().scan(clean), { status: 'error', scanner: 'clamd', reason }, reply);
    }
  });

  it('a file above the scan limit is refused without contacting the daemon', async () => {
    daemon.reset();
    assert.deepEqual(await scanner({ maxBytes: 1_000 }).scan(exactPdf(2_000)), { status: 'error', scanner: 'clamd', reason: 'file_too_large' });
    assert.equal(daemon.connections, 0);
  });

  it('concurrent scans: at most maxConcurrent at once, every result correct; a scan that cannot get a slot in time times out', async () => {
    daemon.reset();
    daemon.delayMs = 120;
    const shared = scanner({ maxConcurrent: 2, timeoutMs: 5_000 });
    const files = Array.from({ length: 6 }, (_, i) => (i % 3 === 0 ? infected : makePdf([[`Synthetic ${i}`, 'Clean text.']])));
    const results = await Promise.all(files.map((file) => shared.scan(file)));
    assert.deepEqual(
      results.map((result) => result.status),
      ['infected', 'clean', 'clean', 'infected', 'clean', 'clean'],
    );
    assert.ok(daemon.maxActive <= 2, `never more than two scans at once (saw ${daemon.maxActive})`);
    assert.equal(daemon.streams.length, 6);

    // Deterministic: with two slots and a daemon that never answers, exactly two scans connect; the third waits for a
    // slot until its deadline and never connects.
    daemon.reset();
    daemon.behaviour = 'hang';
    const twoSlots = scanner({ maxConcurrent: 2, timeoutMs: 300 });
    const stuck = await Promise.all([twoSlots.scan(clean), twoSlots.scan(clean), twoSlots.scan(clean)]);
    assert.deepEqual(
      stuck.map((result) => result.status),
      ['timeout', 'timeout', 'timeout'],
    );
    assert.equal(daemon.scans, 2, 'both slots were used at once, and no more');

    daemon.reset();
    daemon.behaviour = 'hang';
    const busy = scanner({ maxConcurrent: 1, timeoutMs: 300 });
    const outcomes = await Promise.all([busy.scan(clean), busy.scan(clean)]);
    assert.deepEqual(
      outcomes.map((result) => result.status),
      ['timeout', 'timeout'],
    );
    assert.equal(daemon.connections, 1, 'the second scan never got a slot');
  });

  it('works over a Unix socket, and answers PING', async () => {
    const local = await startFakeClamd({ socketPath: join(root, 'clamd.sock') });
    try {
      const viaSocket = new ClamdScanner({ endpoint: { socketPath: join(root, 'clamd.sock') }, timeoutMs: 2_000, maxBytes: 1024 * 1024, maxConcurrent: 1 });
      assert.equal((await viaSocket.scan(clean)).status, 'clean');
      assert.equal((await viaSocket.scan(infected)).status, 'infected');
      assert.equal(await viaSocket.ping(), true);
    } finally {
      await local.close();
    }
  });

  it('parses only exact clamd answers', () => {
    assert.deepEqual(parseClamdReply('stream: OK'), { status: 'clean', scanner: 'clamd' });
    assert.deepEqual(parseClamdReply('stream: Win.Test.EICAR_HDB-1 FOUND'), { status: 'infected', scanner: 'clamd', signature: 'Win.Test.EICAR_HDB-1' });
    assert.deepEqual(
      parseClamdReply('stream: <script> FOUND'),
      { status: 'infected', scanner: 'clamd', signature: 'unrecognized-signature' },
      'an odd name is still a detection, without the raw name',
    );
    assert.equal(parseClamdReply('').status, 'error');
    assert.equal(parseClamdReply('stream: ok').status, 'error');
  });
});

describe('scan enforcement policy (AP-040E)', () => {
  const results: MalwareScanResult[] = [
    { status: 'clean', scanner: 'clamd' },
    { status: 'infected', scanner: 'clamd', signature: 'X' },
    { status: 'not_scanned', scanner: 'none' },
    { status: 'unavailable', scanner: 'clamd', reason: 'connect_failed' },
    { status: 'timeout', scanner: 'clamd', reason: 'deadline' },
    { status: 'error', scanner: 'clamd', reason: 'invalid_response' },
    { status: 'surprise', scanner: 'clamd' } as unknown as MalwareScanResult,
  ];
  const decide = (enforcement: ScanEnforcement) => results.map((result) => decideScan(result, enforcement));

  it('only a clean result is ever recorded as clean; infected is always refused', () => {
    for (const enforcement of ['compatibility', 'strict'] as const) {
      const decisions = decide(enforcement);
      assert.deepEqual(decisions[0], { action: 'accept', status: 'clean', scanner: 'clamd' });
      assert.equal(decisions[1]!.action, 'reject_infected');
      for (const decision of decisions.slice(2)) assert.ok(!(decision.action === 'accept' && decision.status === 'clean'), JSON.stringify(decision));
    }
  });

  it('compatibility keeps unverified files as not_scanned, naming the failed scanner', () => {
    assert.deepEqual(
      decide('compatibility')
        .slice(2)
        .map((decision) => (decision.action === 'accept' ? `${decision.status}/${decision.scanner}` : decision.action)),
      ['not_scanned/none', 'not_scanned/clamd:unavailable', 'not_scanned/clamd:timeout', 'not_scanned/clamd:error', 'not_scanned/clamd:error'],
    );
  });

  it('strict refuses every file without a verified clean result', () => {
    assert.deepEqual(
      decide('strict')
        .slice(2)
        .map((decision) => decision.action),
      ['refuse_unverified', 'refuse_unverified', 'refuse_unverified', 'refuse_unverified', 'refuse_unverified'],
    );
  });
});

describe('malware scanning configuration (AP-040E)', () => {
  const base = { NODE_ENV: 'test', DOCUMENT_STORAGE_DIR: '/tmp/ap-config-test' };

  it('is off by default: no scanner, compatibility enforcement', () => {
    const { malwareScanning } = loadConfig(base);
    assert.equal(malwareScanning.scanner, 'none');
    assert.equal(malwareScanning.enforcement, 'compatibility');
    assert.equal(malwareScanning.clamd, null);
    const production = loadConfig({ NODE_ENV: 'production', APP_ORIGINS: 'https://example.edu', DOCUMENT_STORAGE_DIR: '/mnt/documents' }).malwareScanning;
    assert.equal(production.scanner, 'none', 'production behaviour is unchanged unless explicitly configured');
  });

  it('accepts a local clamd: a Unix socket or a loopback address', () => {
    assert.deepEqual(loadConfig({ ...base, MALWARE_SCANNER: 'clamd', CLAMD_SOCKET: '/run/clamav/clamd.sock' }).malwareScanning.clamd, { socketPath: '/run/clamav/clamd.sock' });
    for (const [address, host] of [
      ['127.0.0.1:3310', '127.0.0.1'],
      ['localhost:3310', 'localhost'],
      ['[::1]:3310', '::1'],
    ]) {
      assert.deepEqual(loadConfig({ ...base, MALWARE_SCANNER: 'clamd', CLAMD_ADDRESS: address, MALWARE_SCAN_ENFORCEMENT: 'strict' }).malwareScanning.clamd, { host, port: 3310 });
    }
  });

  it('refuses unsafe or contradictory settings at startup', () => {
    const refused: Array<Record<string, string>> = [
      { MALWARE_SCANNER: 'clamav' },
      { MALWARE_SCAN_ENFORCEMENT: 'strict' },
      { MALWARE_SCAN_ENFORCEMENT: 'lenient', MALWARE_SCANNER: 'clamd', CLAMD_SOCKET: '/run/clamd.sock' },
      { MALWARE_SCANNER: 'clamd' },
      { MALWARE_SCANNER: 'clamd', CLAMD_SOCKET: '/run/clamd.sock', CLAMD_ADDRESS: '127.0.0.1:3310' },
      { MALWARE_SCANNER: 'clamd', CLAMD_SOCKET: 'relative/clamd.sock' },
      { MALWARE_SCANNER: 'clamd', CLAMD_ADDRESS: '10.0.0.5:3310' },
      { MALWARE_SCANNER: 'clamd', CLAMD_ADDRESS: 'clamd.internal:3310' },
      { MALWARE_SCANNER: 'clamd', CLAMD_ADDRESS: '127.0.0.1' },
      { MALWARE_SCANNER: 'clamd', CLAMD_ADDRESS: '127.0.0.1:99999' },
      { CLAMD_ADDRESS: '127.0.0.1:3310' },
      { MALWARE_SCANNER: 'clamd', CLAMD_SOCKET: '/run/clamd.sock', MALWARE_SCAN_MAX_MB: '5', DOCUMENT_MAX_UPLOAD_MB: '10' },
      { MALWARE_SCANNER: 'clamd', CLAMD_SOCKET: '/run/clamd.sock', MALWARE_SCAN_TIMEOUT_SECONDS: '0' },
      { MALWARE_SCANNER: 'clamd', CLAMD_SOCKET: '/run/clamd.sock', MALWARE_SCAN_CONCURRENCY: '64' },
    ];
    for (const env of refused) assert.throws(() => loadConfig({ ...base, ...env }), Error, JSON.stringify(env));
  });
});
