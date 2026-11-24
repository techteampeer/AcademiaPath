/**
 * AP-SEC-05B: freshness of the signatures LOADED in clamd, at the adapter boundary: clamd's `VERSION` answer (parsed
 * strictly), the age policy (current / aging / stale / unknown) on a controlled clock, the brief reuse of an
 * observation, one shared check for concurrent scans, deadlines and abort signals, restarts, and the rule that an
 * infected verdict always wins. Against the synthetic clamd daemon (test/helpers/fake-clamd.ts); no database, no real
 * malware (the only "threat" is the plain-text part of the EICAR antivirus test string).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { ClamdScanner, parseClamdVersion, type ClamdOptions } from '../../src/documents/clamd.js';
import { decideScan } from '../../src/documents/scanner.js';
import {
  assessSignatures,
  DEFAULT_SIGNATURE_POLICY,
  SIGNATURE_CHECK_TTL_MS,
  SIGNATURE_CLOCK_SKEW_MS,
  validateSignaturePolicy,
  type SignatureFreshness,
} from '../../src/documents/signature-freshness.js';
import { makePdf } from '../helpers/documents.js';
import { clamdVersionReply, EICAR_MARKER_TEXT, FAKE_SIGNATURE, startFakeClamd, type FakeClamd } from '../helpers/fake-clamd.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** The controlled clock starts here (a whole second, as clamd's dates are). */
const START = Date.UTC(2026, 10, 24, 12, 0, 0);
const clean = makePdf([['Synthetic handout', 'Nothing to see here.']]);
const infected = makePdf([['Synthetic handout', `Test marker ${EICAR_MARKER_TEXT} inside.`]]);
const CLEAN = { status: 'clean', scanner: 'clamd' };
const STALE = { status: 'error', scanner: 'clamd', reason: 'signatures_stale' };
const UNVERIFIED = { status: 'error', scanner: 'clamd', reason: 'signatures_unverified' };
const INFECTED = { status: 'infected', scanner: 'clamd', signature: FAKE_SIGNATURE };
const state = (freshness: SignatureFreshness) => (freshness.state === 'unknown' ? `unknown:${freshness.reason}` : freshness.state);

describe('clamd VERSION answer (AP-SEC-05B)', () => {
  it('reads the engine, the daily database version and its build time (UTC), including ctime’s padded day', () => {
    assert.deepEqual(parseClamdVersion('ClamAV 1.5.4/27001/Tue Nov 24 15:37:09 2026'), { kind: 'dated', engine: '1.5.4', databaseVersion: 27001, databaseTime: Date.UTC(2026, 10, 24, 15, 37, 9) });
    assert.deepEqual(parseClamdVersion('ClamAV 1.5.4/28191/Tue Nov  3 05:07:09 2026'), { kind: 'dated', engine: '1.5.4', databaseVersion: 28191, databaseTime: Date.UTC(2026, 10, 3, 5, 7, 9) });
    assert.equal(parseClamdVersion('ClamAV 1.4.3/27001/Tue Feb 29 00:00:00 2028').kind, 'dated', 'a real leap day');
    assert.equal(parseClamdVersion(`${clamdVersionReply(START)}\n`).kind, 'dated', 'the newline-terminated form');
    for (const time of [START, Date.UTC(2027, 0, 1, 0, 0, 0), Date.UTC(2026, 1, 9, 23, 59, 59)]) {
      assert.equal((parseClamdVersion(clamdVersionReply(time)) as { databaseTime: number }).databaseTime, time, 'the test daemon’s format round-trips');
    }
  });

  it('without a daily database, clamd names only its engine: no signature date', () => {
    assert.deepEqual(parseClamdVersion('ClamAV 1.5.4'), { kind: 'undated', engine: '1.5.4' });
  });

  it('a disabled VERSION command is unavailable; every other form or impossible date is unsupported, never dated', () => {
    assert.deepEqual(parseClamdVersion('COMMAND UNAVAILABLE'), { kind: 'unavailable' });
    for (const reply of [
      '',
      'PONG',
      'UNKNOWN COMMAND',
      'ClamAV',
      'ClamAV ready',
      'ClamAV devel-20261124',
      'clamav 1.5.4/27001/Tue Nov 24 15:37:09 2026',
      'ClamAV 1.5.4/27001',
      'ClamAV 1.5.4/27001/',
      'ClamAV 1.5.4/0/Tue Nov 24 15:37:09 2026',
      'ClamAV 1.5.4/-1/Tue Nov 24 15:37:09 2026',
      'ClamAV 1.5.4/27001/Tue Nov 24 15:37:09 2026 UTC',
      'ClamAV 1.5.4/27001/Tue Nov 24 15:37 2026',
      'ClamAV 1.5.4/27001/2026-11-24T15:37:09Z',
      'ClamAV 1.5.4/27001/1795534629',
      'ClamAV 1.5.4/27001/Mon Nov 24 15:37:09 2026',
      'ClamAV 1.5.4/27001/Tue Feb 30 15:37:09 2026',
      'ClamAV 1.5.4/27001/Sun Feb 29 15:37:09 2026',
      'ClamAV 1.5.4/27001/Tue Nov 24 24:00:00 2026',
      'ClamAV 1.5.4/27001/Tue Nov 24 15:60:09 2026',
      'ClamAV 1.5.4/27001/Tue Nov 24 15:37:60 2026',
      'ClamAV 1.5.4/27001/Thu Jan  1 00:00:00 1969',
      'ClamAV 1.5.4/27001/Tue Nov 24 15:37:09 2026/extra',
      'ClamAV 1.5.4 /27001/Tue Nov 24 15:37:09 2026',
      'stream: OK',
    ]) {
      assert.deepEqual(parseClamdVersion(reply), { kind: 'unsupported' }, JSON.stringify(reply));
    }
  });
});

describe('signature age policy (AP-SEC-05B)', () => {
  const at = (ageMs: number) => assessSignatures({ engine: '1.5.4', databaseVersion: 27001, databaseTime: START - ageMs }, START, DEFAULT_SIGNATURE_POLICY);

  it('current under 48 h, aging from 48 h, stale from 7 days (exact boundaries)', () => {
    const cases: Array<[string, number, string]> = [
      ['just built', 0, 'current'],
      ['1 hour', HOUR, 'current'],
      ['47 hours', 47 * HOUR, 'current'],
      ['1 ms before 48 hours', 48 * HOUR - 1, 'current'],
      ['exactly 48 hours', 48 * HOUR, 'aging'],
      ['6 days', 6 * DAY, 'aging'],
      ['1 ms before 7 days', 7 * DAY - 1, 'aging'],
      ['exactly 7 days', 7 * DAY, 'stale'],
      ['30 days', 30 * DAY, 'stale'],
    ];
    for (const [label, age, expected] of cases) {
      const freshness = at(age);
      assert.equal(freshness.state, expected, label);
      if (freshness.state !== 'unknown') assert.equal(freshness.ageMs, age, label);
    }
  });

  it('a build time ahead of the clock is clock skew up to 5 minutes (counted as just built); further ahead it is unknown', () => {
    assert.equal(SIGNATURE_CLOCK_SKEW_MS, 5 * 60_000);
    assert.deepEqual(at(-SIGNATURE_CLOCK_SKEW_MS), { state: 'current', ageMs: 0, databaseVersion: 27001, databaseTime: START + SIGNATURE_CLOCK_SKEW_MS });
    assert.deepEqual(at(-SIGNATURE_CLOCK_SKEW_MS - 1), { state: 'unknown', reason: 'future_timestamp' });
    assert.deepEqual(at(-DAY), { state: 'unknown', reason: 'future_timestamp' });
    assert.deepEqual(assessSignatures({ engine: '1.5.4', databaseVersion: 1, databaseTime: Number.NaN }, START, DEFAULT_SIGNATURE_POLICY), { state: 'unknown', reason: 'future_timestamp' });
  });

  it('limits are configurable, validated at startup, and refused without a scanner', () => {
    const base = { NODE_ENV: 'test', DOCUMENT_STORAGE_DIR: '/tmp/ap-config-test' };
    const clamd = { ...base, DOCUMENT_UPLOAD_TIMEOUT_SECONDS: '60', MALWARE_SCANNER: 'clamd', CLAMD_SOCKET: '/run/clamav/clamd.sock' };
    assert.deepEqual(loadConfig(base).malwareScanning.signatures, { agingAfterMs: 48 * HOUR, staleAfterMs: 7 * DAY }, 'defaults');
    assert.deepEqual(loadConfig(clamd).malwareScanning.signatures, { agingAfterMs: 48 * HOUR, staleAfterMs: 7 * DAY });
    assert.deepEqual(loadConfig({ ...clamd, MALWARE_SIGNATURES_AGING_HOURS: '24', MALWARE_SIGNATURES_STALE_HOURS: '72' }).malwareScanning.signatures, { agingAfterMs: 24 * HOUR, staleAfterMs: 72 * HOUR });
    for (const env of [
      { MALWARE_SIGNATURES_AGING_HOURS: '168' },
      { MALWARE_SIGNATURES_AGING_HOURS: '200', MALWARE_SIGNATURES_STALE_HOURS: '100' },
      { MALWARE_SIGNATURES_AGING_HOURS: '0' },
      { MALWARE_SIGNATURES_AGING_HOURS: '-1' },
      { MALWARE_SIGNATURES_AGING_HOURS: '1.5' },
      { MALWARE_SIGNATURES_AGING_HOURS: 'two days' },
      { MALWARE_SIGNATURES_STALE_HOURS: '337' },
      { MALWARE_SIGNATURES_STALE_HOURS: '48' },
    ]) {
      assert.throws(() => loadConfig({ ...clamd, ...env }), /MALWARE_SIGNATURES/, JSON.stringify(env));
    }
    assert.throws(() => loadConfig({ ...base, MALWARE_SIGNATURES_STALE_HOURS: '72' }), /only with MALWARE_SCANNER=clamd/);
    for (const policy of [
      { agingAfterMs: 0, staleAfterMs: DAY },
      { agingAfterMs: DAY, staleAfterMs: DAY },
      { agingAfterMs: DAY, staleAfterMs: 15 * DAY },
      { agingAfterMs: 0.5, staleAfterMs: DAY },
    ]) {
      assert.throws(() => validateSignaturePolicy(policy), /signature age limits/, JSON.stringify(policy));
    }
  });
});

describe('clamd adapter with signature freshness (AP-SEC-05B, synthetic daemon, controlled clock)', () => {
  let daemon: FakeClamd;
  let now = START;
  let checks: SignatureFreshness[] = [];
  const scanner = (options: Partial<ClamdOptions> = {}) =>
    new ClamdScanner({
      endpoint: { host: '127.0.0.1', port: daemon.port },
      timeoutMs: 2_000,
      maxBytes: 5 * 1024 * 1024,
      maxConcurrent: 4,
      signatures: { policy: DEFAULT_SIGNATURE_POLICY, now: () => now, onCheck: (freshness) => void checks.push(freshness) },
      ...options,
    });
  /** The daemon's daily database was built `ageMs` before the controlled clock's current time. */
  const builtAgo = (ageMs: number, version = 27001) => clamdVersionReply(now - ageMs, version);
  const reset = () => {
    daemon.reset();
    now = START;
    checks = [];
  };

  before(async () => {
    daemon = await startFakeClamd();
  });
  after(async () => {
    await daemon.close();
  });

  it('1–5. a clean answer is clean with current (1 h, 47 h) or aging (48 h, 6 days) signatures, and not a verdict from 7 days', async () => {
    const cases: Array<[string, number, object, string]> = [
      ['1 hour', HOUR, CLEAN, 'current'],
      ['47 hours', 47 * HOUR, CLEAN, 'current'],
      ['exactly 48 hours', 48 * HOUR, CLEAN, 'aging'],
      ['6 days', 6 * DAY, CLEAN, 'aging'],
      ['exactly 7 days', 7 * DAY, STALE, 'stale'],
      ['10 days', 10 * DAY, STALE, 'stale'],
    ];
    for (const [label, age, expected, observed] of cases) {
      reset();
      daemon.version = builtAgo(age);
      assert.deepEqual(await scanner().scan(clean), expected, label);
      assert.deepEqual(checks.map(state), [observed], `${label}: one check, reported once`);
      assert.equal(daemon.streams.length, 1, `${label}: the file was scanned in full`);
    }
  });

  it('6–10. missing, malformed, unsupported or future metadata is unknown: never clean; clock skew within 5 minutes is tolerated', async () => {
    const cases: Array<[string, string, object, string]> = [
      ['no daily database (no date)', 'ClamAV 1.5.4', UNVERIFIED, 'unknown:no_signature_date'],
      ['malformed date', 'ClamAV 1.5.4/27001/Tue Feb 30 15:37:09 2026', UNVERIFIED, 'unknown:unsupported_response'],
      ['garbage', 'ClamAV ready', UNVERIFIED, 'unknown:unsupported_response'],
      ['VERSION disabled', 'COMMAND UNAVAILABLE', UNVERIFIED, 'unknown:version_unavailable'],
      ['VERSION unknown to the daemon', 'UNKNOWN COMMAND', UNVERIFIED, 'unknown:unsupported_response'],
      ['an hour in the future', builtAgo(-HOUR), UNVERIFIED, 'unknown:future_timestamp'],
      ['1 s beyond the clock skew', builtAgo(-SIGNATURE_CLOCK_SKEW_MS - 1_000), UNVERIFIED, 'unknown:future_timestamp'],
      ['exactly the clock skew ahead', builtAgo(-SIGNATURE_CLOCK_SKEW_MS), CLEAN, 'current'],
      ['a minute ahead', builtAgo(-60_000), CLEAN, 'current'],
    ];
    for (const [label, reply, expected, observed] of cases) {
      reset();
      daemon.version = reply;
      assert.deepEqual(await scanner().scan(clean), expected, label);
      assert.deepEqual(checks.map(state), [observed], label);
    }
  });

  it('11. an unreachable scanner is unavailable (the scan failure stands)', async () => {
    reset();
    const closed = await startFakeClamd();
    const port = closed.port;
    await closed.close();
    assert.deepEqual(await scanner({ endpoint: { host: '127.0.0.1', port } }).scan(clean), { status: 'unavailable', scanner: 'clamd', reason: 'connect_failed' });
  });

  it('12. a check that does not answer ends at the scan’s deadline: a timeout, never clean, and never later', async () => {
    reset();
    daemon.version = 'hang';
    const started = Date.now();
    const result = await scanner({ timeoutMs: 5_000 }).scan(clean, undefined, { deadline: Date.now() + 300 });
    const elapsed = Date.now() - started;
    assert.deepEqual(result, { status: 'timeout', scanner: 'clamd', reason: 'deadline' });
    assert.ok(elapsed >= 250 && elapsed < 1_500, `ended at the deadline (${elapsed} ms)`);
    assert.equal(daemon.streams.length, 1, 'the file itself was scanned clean meanwhile');

    // The shared check also ends on its own (the scanner timeout, at most 5 s), whoever waits for it: unknown.
    reset();
    daemon.version = 'hang';
    const ownLimit = Date.now();
    assert.deepEqual(await scanner({ timeoutMs: 300 }).checkSignatures(3_000), { state: 'unknown', reason: 'timeout' });
    assert.ok(Date.now() - ownLimit < 1_500, 'ended by its own limit');
    assert.deepEqual(checks.map(state), ['unknown:timeout']);
    // And a scan whose check ends that way is a timeout too, whichever limit fires first.
    reset();
    daemon.version = 'hang';
    assert.deepEqual(await scanner({ timeoutMs: 300 }).scan(clean), { status: 'timeout', scanner: 'clamd', reason: 'deadline' });
  });

  it('12b. an aborted request stops waiting for the check at once', async () => {
    reset();
    daemon.version = 'hang';
    const controller = new AbortController();
    const started = Date.now();
    const pending = scanner({ timeoutMs: 5_000 }).scan(clean, undefined, { signal: controller.signal, deadline: Date.now() + 5_000 });
    setTimeout(() => controller.abort(), 150);
    assert.deepEqual(await pending, { status: 'timeout', scanner: 'clamd', reason: 'deadline' });
    assert.ok(Date.now() - started < 1_500, 'not held until the deadline');
  });

  it('13. a check whose connection closes without an answer is unknown; a scan interrupted mid-stream stays an error', async () => {
    reset();
    daemon.version = 'close';
    assert.deepEqual(await scanner().scan(clean), UNVERIFIED);
    assert.deepEqual(checks.map(state), ['unknown:interrupted']);
    reset();
    daemon.behaviour = 'close_mid_stream';
    assert.deepEqual(await scanner().scan(makePdf([['Synthetic', 'x'.repeat(200_000)]]), undefined), { status: 'error', scanner: 'clamd', reason: 'interrupted' });
  });

  it('14. an observation is reused for at most a minute; its state is recomputed on every use, so it still ages; failures are not reused', async () => {
    reset();
    const shared = scanner();
    // Built 7 days minus 30 s ago: aging now, stale 30 s later, while the observation is still being reused.
    daemon.version = builtAgo(7 * DAY - 30_000);
    assert.deepEqual(await shared.scan(clean), CLEAN);
    now += 29_000;
    assert.deepEqual(await shared.scan(clean), CLEAN, 'still aging');
    now += 1_000;
    assert.deepEqual(await shared.scan(clean), STALE, 'stale without asking again');
    assert.equal(daemon.versionRequests, 1, 'one VERSION request so far');

    // After the reuse window the daemon is asked again.
    now = START + SIGNATURE_CHECK_TTL_MS - 1;
    await shared.scan(clean);
    assert.equal(daemon.versionRequests, 1, 'still within the window');
    now = START + SIGNATURE_CHECK_TTL_MS;
    daemon.version = builtAgo(HOUR);
    assert.deepEqual(await shared.scan(clean), CLEAN, 'the new observation');
    assert.equal(daemon.versionRequests, 2);

    // A clock that went backwards does not extend the reuse.
    now -= 10 * 60_000;
    await shared.scan(clean);
    assert.equal(daemon.versionRequests, 3);

    // A failed check is not reused: the next scan asks again, and recovers as soon as the daemon answers.
    reset();
    const recovering = scanner();
    daemon.version = 'COMMAND UNAVAILABLE';
    assert.deepEqual(await recovering.scan(clean), UNVERIFIED);
    daemon.version = builtAgo(HOUR);
    assert.deepEqual(await recovering.scan(clean), CLEAN);
    assert.equal(daemon.versionRequests, 2);
  });

  it('15. concurrent scans share one check: one VERSION request, one report, every verdict right', async () => {
    for (const [age, expected] of [
      [HOUR, CLEAN],
      [8 * DAY, STALE],
    ] as const) {
      reset();
      daemon.version = builtAgo(age);
      daemon.versionDelayMs = 150;
      const shared = scanner({ maxConcurrent: 4 });
      const files = Array.from({ length: 12 }, (_, i) => (i % 4 === 3 ? infected : makePdf([[`Synthetic ${i}`, 'Clean text.']])));
      const results = await Promise.all(files.map((file) => shared.scan(file)));
      assert.deepEqual(
        results,
        files.map((file) => (file === infected ? INFECTED : expected)),
      );
      assert.equal(daemon.versionRequests, 1, 'a single shared check');
      assert.equal(checks.length, 1, 'reported once');
      assert.ok(daemon.maxActive <= 4);
    }
  });

  it('16. a restarted scanner or a new database is noticed: after the reuse window, and at once after a lost connection', async () => {
    reset();
    const shared = scanner();
    daemon.version = builtAgo(HOUR, 27001);
    assert.deepEqual(await shared.scan(clean), CLEAN);
    // A database update (clamd reloaded): seen once the observation is older than the reuse window.
    daemon.version = builtAgo(10 * 60_000, 27002);
    now += SIGNATURE_CHECK_TTL_MS;
    assert.deepEqual(await shared.scan(clean), CLEAN);
    assert.deepEqual(
      checks.map((check) => (check.state === 'unknown' ? null : check.databaseVersion)),
      [27001, 27002],
    );

    // A restart with older signatures: the scan in progress loses its connection, so the observation is dropped and the
    // very next scan asks again, inside the reuse window.
    daemon.behaviour = 'close_before_reply';
    assert.equal((await shared.scan(clean)).status, 'error');
    daemon.behaviour = 'scan';
    daemon.version = builtAgo(9 * DAY, 26990);
    assert.deepEqual(await shared.scan(clean), STALE);
    assert.equal(daemon.versionRequests, 3);

    // The same when the restarting daemon refuses connections for a moment.
    reset();
    const restarting = scanner();
    daemon.version = builtAgo(HOUR);
    assert.deepEqual(await restarting.scan(clean), CLEAN);
    const port = daemon.port;
    await daemon.close();
    assert.equal((await restarting.scan(clean)).status, 'unavailable');
    daemon = await startFakeClamd();
    const moved = scanner({ endpoint: { host: '127.0.0.1', port: daemon.port } });
    assert.notEqual(port, 0);
    daemon.version = 'ClamAV 1.5.4';
    assert.deepEqual(await moved.scan(clean), UNVERIFIED);
  });

  it('17–18. an infected verdict always wins: with current, stale or unknown signatures, and without waiting for the check', async () => {
    for (const [label, version] of [
      ['current', builtAgo(HOUR)],
      ['stale', builtAgo(30 * DAY)],
      ['no date', 'ClamAV 1.5.4'],
      ['VERSION disabled', 'COMMAND UNAVAILABLE'],
    ] as const) {
      reset();
      daemon.version = version;
      assert.deepEqual(await scanner().scan(infected), INFECTED, label);
    }
    reset();
    daemon.version = 'hang';
    const started = Date.now();
    assert.deepEqual(await scanner({ timeoutMs: 3_000 }).scan(infected), INFECTED);
    assert.ok(Date.now() - started < 1_000, 'not held by a check that does not answer');
  });

  it('the scan policy: stale or unknown signatures are refused in strict mode and labelled not_scanned in compatibility', () => {
    for (const [reason, label] of [
      ['signatures_stale', 'clamd:signatures_stale'],
      ['signatures_unverified', 'clamd:signatures_unverified'],
    ] as const) {
      const result = { status: 'error', scanner: 'clamd', reason } as const;
      assert.deepEqual(decideScan(result, 'strict'), { action: 'refuse_unverified', scanner: 'clamd', status: 'error', reason });
      assert.deepEqual(decideScan(result, 'compatibility'), { action: 'accept', status: 'not_scanned', scanner: label });
    }
    assert.deepEqual(decideScan({ status: 'error', scanner: 'clamd', reason: 'scanner_error' }, 'compatibility'), { action: 'accept', status: 'not_scanned', scanner: 'clamd:error' }, 'other labels unchanged');
  });

  it('checkSignatures asks now (for the startup log); without a policy nothing is checked', async () => {
    reset();
    daemon.version = builtAgo(3 * DAY);
    const shared = scanner();
    assert.equal((await shared.checkSignatures())?.state, 'aging');
    assert.equal((await shared.checkSignatures())?.state, 'aging');
    assert.equal(daemon.versionRequests, 2, 'not served from the reuse window');
    reset();
    daemon.version = builtAgo(30 * DAY);
    const unchecked = scanner({ signatures: null });
    assert.equal(await unchecked.checkSignatures(), null);
    assert.deepEqual(await unchecked.scan(clean), CLEAN, 'protocol-only adapter (tests only)');
    assert.equal(daemon.versionRequests, 0);
  });
});
