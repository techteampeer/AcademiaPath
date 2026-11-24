/**
 * AP-040E: the clamd adapter against a REAL ClamAV daemon, when one is installed (`clamd` on the PATH, /usr/sbin/clamd,
 * or CLAMD_BINARY). Skipped otherwise (CI does not install ClamAV). The daemon runs locally with a temporary
 * configuration and a single custom test signature for the plain-text part of the EICAR antivirus test string: no
 * official signature download, no real malware, nothing leaves the machine.
 *
 * It also shows why clamd's own configuration matters: without `AlertExceedsMax yes`, clamd answers `stream: OK` for a
 * file larger than its MaxFileSize, which it did not scan (see docs/malware-scanning.md).
 *
 * AP-SEC-05B: signature freshness against the real daemon, with a synthetic daily database built locally by ClamAV's
 * own `sigtool --unsigned` (skipped without sigtool): clamd's VERSION answer, the build time in the engine (not the file
 * on disk), RELOAD, a disabled VERSION command, a daemon without a daily database, and clamd's time zone.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ClamdScanner, type ClamdOptions } from '../../src/documents/clamd.js';
import { DEFAULT_SIGNATURE_POLICY, type SignatureFreshness } from '../../src/documents/signature-freshness.js';
import { makeDocx, makePdf, makePptx } from '../helpers/documents.js';
import { EICAR_MARKER_TEXT } from '../helpers/fake-clamd.js';
import { exactPdf } from '../helpers/uploads.js';

const binary = [process.env.CLAMD_BINARY, ...(process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, 'clamd')), '/usr/sbin/clamd'].find((path) => path && existsSync(path));
const sigtool = [process.env.SIGTOOL_BINARY, ...(process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, 'sigtool')), '/usr/bin/sigtool'].find((path) => path && existsSync(path));
const SIGNATURE = 'AcademiaPath.Test.EICAR-Marker.UNOFFICIAL';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A clamd process with its own directory, configuration and test signature; AP-SEC-05B: or, with `daily`, only that
 * synthetic daily database, and with `env` its own environment (for example TZ).
 */
async function startClamd(root: string, name: string, settings: string[], options: { daily?: string; env?: Record<string, string> } = {}): Promise<{ socketPath: string; process: ChildProcess; dir: string }> {
  const dir = join(root, name);
  await mkdir(join(dir, 'db'), { recursive: true });
  if (options.daily) await copyFile(options.daily, join(dir, 'db', 'daily.cud'));
  else await writeFile(join(dir, 'db', 'academiapath-test.ndb'), `AcademiaPath.Test.EICAR-Marker:0:*:${Buffer.from(EICAR_MARKER_TEXT).toString('hex')}\n`);
  const socketPath = join(dir, 'clamd.sock');
  await writeFile(join(dir, 'clamd.conf'), [`Foreground yes`, `LocalSocket ${socketPath}`, `DatabaseDirectory ${join(dir, 'db')}`, `TemporaryDirectory ${dir}`, ...settings, ''].join('\n'));
  const child = spawn(binary!, ['-c', join(dir, 'clamd.conf')], { stdio: 'ignore', env: { ...process.env, TZ: 'Etc/UTC', ...options.env } });
  const probe = new ClamdScanner({ endpoint: { socketPath }, timeoutMs: 1_000, maxBytes: 1, maxConcurrent: 1, signatures: null });
  for (let i = 0; i < 120; i += 1) {
    if (existsSync(socketPath) && (await probe.ping(1_000))) return { socketPath, process: child, dir };
    await sleep(250);
  }
  child.kill('SIGKILL');
  throw new Error('clamd did not start');
}

describe('clamd adapter against a real ClamAV daemon (AP-040E)', { skip: binary ? false : 'clamd is not installed' }, () => {
  let root: string;
  let safe: { socketPath: string; process: ChildProcess };
  let unsafe: { socketPath: string; process: ChildProcess };
  const scanner = (socketPath: string, maxBytes = 20 * 1024 * 1024) => new ClamdScanner({ endpoint: { socketPath }, timeoutMs: 20_000, maxBytes, maxConcurrent: 3, signatures: null });
  const marker = `Synthetic test marker ${EICAR_MARKER_TEXT} in a document.`;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ap-clamd-real-'));
    // The configuration docs/malware-scanning.md requires, with small limits for the test.
    safe = await startClamd(root, 'safe', ['StreamMaxLength 4M', 'MaxFileSize 1M', 'MaxScanSize 8M', 'AlertExceedsMax yes']);
    // ClamAV's default: files above MaxFileSize are skipped and reported OK.
    unsafe = await startClamd(root, 'unsafe', ['StreamMaxLength 4M', 'MaxFileSize 1M', 'MaxScanSize 8M', 'AlertExceedsMax no']);
  });

  after(async () => {
    for (const daemon of [safe, unsafe]) daemon?.process.kill('SIGKILL');
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('PDF, DOCX and PPTX: clean files are clean; the test marker is detected, also inside compressed Office files', async () => {
    const clamd = scanner(safe.socketPath);
    for (const [label, file] of [
      ['pdf', makePdf([['Synthetic handout', 'Clean text.']])],
      ['docx', makeDocx(['Synthetic clean notes.'])],
      ['pptx', makePptx([['Synthetic clean slide']])],
    ] as const) {
      assert.deepEqual(await clamd.scan(file), { status: 'clean', scanner: 'clamd' }, label);
    }
    for (const [label, file] of [
      ['pdf', makePdf([['Synthetic handout', marker]])],
      ['docx', makeDocx([marker])],
      ['pptx', makePptx([[marker]])],
    ] as const) {
      assert.deepEqual(await clamd.scan(file), { status: 'infected', scanner: 'clamd', signature: SIGNATURE }, label);
    }
  });

  it('concurrent scans against the real daemon all get the right verdict', async () => {
    const clamd = scanner(safe.socketPath);
    const files = Array.from({ length: 8 }, (_, i) => makePdf([['Synthetic', i % 2 ? marker : `Clean ${i}.`]]));
    const results = await Promise.all(files.map((file) => clamd.scan(file)));
    assert.deepEqual(
      results.map((result) => result.status),
      ['clean', 'infected', 'clean', 'infected', 'clean', 'infected', 'clean', 'infected'],
    );
  });

  it('a file above clamd’s scan limit is not clean: an error with AlertExceedsMax yes', async () => {
    const big = exactPdf(2 * 1024 * 1024);
    assert.deepEqual(await scanner(safe.socketPath).scan(big), { status: 'error', scanner: 'clamd', reason: 'limits_exceeded' });
    // Why the setting is required: clamd's default reports the unscanned file as OK.
    assert.equal((await scanner(unsafe.socketPath).scan(big)).status, 'clean');
  });

  it('a stream above clamd’s StreamMaxLength is an error, never clean', async () => {
    const result = await scanner(safe.socketPath).scan(exactPdf(6 * 1024 * 1024));
    assert.equal(result.status, 'error');
    assert.ok(result.status === 'error' && ['file_too_large', 'interrupted'].includes(result.reason), JSON.stringify(result));
  });
});

/**
 * AP-SEC-05B: a synthetic daily database built by ClamAV's own sigtool (an unsigned `.cud`, which clamd loads like an
 * official daily database), with one test signature. Returns its path and the build time sigtool wrote in its header.
 */
async function buildDaily(dir: string, version: number): Promise<{ path: string; builtAt: number }> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'daily.ndb'), `AcademiaPath.Test.Daily-Marker:0:*:${Buffer.from(EICAR_MARKER_TEXT).toString('hex')}\n`);
  await writeFile(join(dir, 'COPYING'), 'Synthetic test signature database for AcademiaPath.\n');
  spawnSync(sigtool!, ['--unsigned', '--build=daily.cud', `--cvd-version=${version}`, '--no-cdiff', `--datadir=${dir}`], { cwd: dir, input: 'academiapath-test\n', stdio: ['pipe', 'ignore', 'ignore'], timeout: 30_000 });
  const path = join(dir, 'daily.cud');
  return { path, builtAt: Number(headerFields(await readFile(path))[8]) * 1000 };
}

/** The colon-separated fields of a CVD/CUD header (its first 512 bytes). */
const headerFields = (file: Buffer) => file.subarray(0, 512).toString('latin1').trimEnd().split(':');

/** Sends one clamd command (for example `zRELOAD`) and returns its answer. */
function command(socketPath: string, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath }, () => socket.write(`${name}\0`));
    let answer = '';
    socket.setTimeout(5_000, () => socket.destroy(new Error('no answer')));
    socket.on('data', (chunk) => (answer += chunk.toString('latin1')));
    socket.on('end', () => resolve(answer.replace(/\0$/, '')));
    socket.on('error', reject);
  });
}

describe('loaded signature freshness against a real ClamAV daemon (AP-SEC-05B)', { skip: binary && sigtool ? false : 'clamd or sigtool is not installed' }, () => {
  let root: string;
  let daily: { path: string; builtAt: number };
  const daemons: Record<'fresh' | 'reload' | 'noversion' | 'eastern' | 'nodaily', { socketPath: string; process: ChildProcess; dir: string }> = {} as never;
  const clean = makePdf([['Synthetic handout', 'Clean text.']]);
  const marked = makePdf([['Synthetic handout', `Synthetic test marker ${EICAR_MARKER_TEXT}.`]]);
  /** A scanner judging the signatures at `now` (the controlled clock), reporting each check. */
  const scanner = (socketPath: string, now: number, checks: SignatureFreshness[] = [], options: Partial<ClamdOptions> = {}) =>
    new ClamdScanner({
      endpoint: { socketPath },
      timeoutMs: 20_000,
      maxBytes: 4 * 1024 * 1024,
      maxConcurrent: 2,
      signatures: { policy: DEFAULT_SIGNATURE_POLICY, now: () => now, onCheck: (freshness) => void checks.push(freshness) },
      ...options,
    });
  const HOUR = 60 * 60_000;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ap-clamd-sig-'));
    daily = await buildDaily(join(root, 'build-27001'), 27001);
    const limits = ['StreamMaxLength 4M', 'MaxFileSize 1M', 'MaxScanSize 8M', 'AlertExceedsMax yes'];
    daemons.fresh = await startClamd(root, 'fresh', limits, { daily: daily.path });
    daemons.reload = await startClamd(root, 'reload', limits, { daily: daily.path });
    daemons.noversion = await startClamd(root, 'noversion', [...limits, 'EnableVersionCommand no'], { daily: daily.path });
    daemons.eastern = await startClamd(root, 'eastern', limits, { daily: daily.path, env: { TZ: 'Asia/Kolkata' } });
    daemons.nodaily = await startClamd(root, 'nodaily', limits);
  });

  after(async () => {
    for (const daemon of Object.values(daemons)) daemon?.process.kill('SIGKILL');
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('VERSION reports the loaded daily database: its version and the build time in its header (UTC)', async () => {
    const freshness = await scanner(daemons.fresh.socketPath, daily.builtAt + HOUR).checkSignatures();
    assert.deepEqual(freshness, { state: 'current', ageMs: HOUR, databaseVersion: 27001, databaseTime: daily.builtAt });
    assert.match(await command(daemons.fresh.socketPath, 'zVERSION'), /^ClamAV \d[^/]*\/27001\/(Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
  });

  it('with the same loaded signatures: clean while current or aging, not a verdict once stale; infected always infected', async () => {
    const socket = daemons.fresh.socketPath;
    assert.deepEqual(await scanner(socket, daily.builtAt + HOUR).scan(clean), { status: 'clean', scanner: 'clamd' });
    assert.deepEqual(await scanner(socket, daily.builtAt + 3 * 24 * HOUR).scan(clean), { status: 'clean', scanner: 'clamd' }, 'aging');
    assert.deepEqual(await scanner(socket, daily.builtAt + 7 * 24 * HOUR).scan(clean), { status: 'error', scanner: 'clamd', reason: 'signatures_stale' });
    for (const now of [daily.builtAt + HOUR, daily.builtAt + 30 * 24 * HOUR]) {
      const result = await scanner(socket, now).scan(marked);
      assert.equal(result.status, 'infected', JSON.stringify(result));
      assert.match((result as { signature: string }).signature, /^AcademiaPath\.Test\.Daily-Marker/);
    }
  });

  it('the date is the engine’s: a damaged database file is refused on RELOAD and the old engine keeps answering; a new one is seen after RELOAD', async () => {
    const socket = daemons.reload.socketPath;
    const loaded = join(daemons.reload.dir, 'db', 'daily.cud');
    // Rewrite the header's build time on disk to 30 days earlier, then ask clamd to reload.
    const file = await readFile(loaded);
    const fields = headerFields(file);
    fields[8] = String(Math.floor((daily.builtAt - 30 * 24 * HOUR) / 1000));
    await writeFile(loaded, Buffer.concat([Buffer.from(fields.join(':').padEnd(512, ' '), 'latin1'), file.subarray(512)]));
    assert.equal(await command(socket, 'zRELOAD'), 'RELOADING');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const unchanged = await scanner(socket, daily.builtAt + HOUR).checkSignatures();
    assert.deepEqual(unchanged, { state: 'current', ageMs: HOUR, databaseVersion: 27001, databaseTime: daily.builtAt }, 'still the loaded engine’s date, not the file’s');

    // A new daily database: once reloaded, VERSION reports it.
    const next = await buildDaily(join(root, 'build-27002'), 27002);
    await copyFile(next.path, loaded);
    assert.equal(await command(socket, 'zRELOAD'), 'RELOADING');
    let seen: SignatureFreshness | null = null;
    for (let i = 0; i < 40; i += 1) {
      seen = await scanner(socket, next.builtAt + HOUR).checkSignatures();
      if (seen?.state !== 'unknown' && seen?.databaseVersion === 27002) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.deepEqual(seen, { state: 'current', ageMs: HOUR, databaseVersion: 27002, databaseTime: next.builtAt });
  });

  it('without a daily database, or with VERSION disabled, the age is unknown: clean is not a verdict, infected still is', async () => {
    for (const [label, daemon, reason] of [
      ['no daily database', daemons.nodaily, 'no_signature_date'],
      ['EnableVersionCommand no', daemons.noversion, 'version_unavailable'],
    ] as const) {
      const checks: SignatureFreshness[] = [];
      assert.deepEqual(await scanner(daemon.socketPath, daily.builtAt + HOUR, checks).scan(clean), { status: 'error', scanner: 'clamd', reason: 'signatures_unverified' }, label);
      assert.deepEqual(checks, [{ state: 'unknown', reason }], label);
      assert.equal((await scanner(daemon.socketPath, daily.builtAt + HOUR).scan(marked)).status, 'infected', label);
    }
    assert.equal(await command(daemons.noversion.socketPath, 'zVERSION'), 'COMMAND UNAVAILABLE');
    assert.match(await command(daemons.nodaily.socketPath, 'zVERSION'), /^ClamAV \d[^/]*$/, 'only the engine');
  });

  it('clamd prints the date in its own time zone: east of UTC it looks like the future and is refused, so clamd must run in UTC', async () => {
    const checks: SignatureFreshness[] = [];
    // TZ=Asia/Kolkata (UTC+5:30): read as UTC, the build time is 5.5 hours ahead of the API's clock.
    assert.deepEqual(await scanner(daemons.eastern.socketPath, daily.builtAt + 60_000, checks).scan(clean), { status: 'error', scanner: 'clamd', reason: 'signatures_unverified' });
    assert.deepEqual(checks, [{ state: 'unknown', reason: 'future_timestamp' }]);
  });
});
