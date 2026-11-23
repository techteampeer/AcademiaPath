/**
 * AP-040E: the clamd adapter against a REAL ClamAV daemon, when one is installed (`clamd` on the PATH, /usr/sbin/clamd,
 * or CLAMD_BINARY). Skipped otherwise (CI does not install ClamAV). The daemon runs locally with a temporary
 * configuration and a single custom test signature for the plain-text part of the EICAR antivirus test string: no
 * official signature download, no real malware, nothing leaves the machine.
 *
 * It also shows why clamd's own configuration matters: without `AlertExceedsMax yes`, clamd answers `stream: OK` for a
 * file larger than its MaxFileSize, which it did not scan (see docs/malware-scanning.md).
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ClamdScanner } from '../../src/documents/clamd.js';
import { makeDocx, makePdf, makePptx } from '../helpers/documents.js';
import { EICAR_MARKER_TEXT } from '../helpers/fake-clamd.js';
import { exactPdf } from '../helpers/uploads.js';

const binary = [process.env.CLAMD_BINARY, ...(process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, 'clamd')), '/usr/sbin/clamd'].find((path) => path && existsSync(path));
const SIGNATURE = 'AcademiaPath.Test.EICAR-Marker.UNOFFICIAL';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A clamd process with its own directory, configuration and test signature. */
async function startClamd(root: string, name: string, settings: string[]): Promise<{ socketPath: string; process: ChildProcess }> {
  const dir = join(root, name);
  await mkdir(join(dir, 'db'), { recursive: true });
  await writeFile(join(dir, 'db', 'academiapath-test.ndb'), `AcademiaPath.Test.EICAR-Marker:0:*:${Buffer.from(EICAR_MARKER_TEXT).toString('hex')}\n`);
  const socketPath = join(dir, 'clamd.sock');
  await writeFile(join(dir, 'clamd.conf'), [`Foreground yes`, `LocalSocket ${socketPath}`, `DatabaseDirectory ${join(dir, 'db')}`, `TemporaryDirectory ${dir}`, ...settings, ''].join('\n'));
  const child = spawn(binary!, ['-c', join(dir, 'clamd.conf')], { stdio: 'ignore' });
  const probe = new ClamdScanner({ endpoint: { socketPath }, timeoutMs: 1_000, maxBytes: 1, maxConcurrent: 1 });
  for (let i = 0; i < 120; i += 1) {
    if (existsSync(socketPath) && (await probe.ping(1_000))) return { socketPath, process: child };
    await sleep(250);
  }
  child.kill('SIGKILL');
  throw new Error('clamd did not start');
}

describe('clamd adapter against a real ClamAV daemon (AP-040E)', { skip: binary ? false : 'clamd is not installed' }, () => {
  let root: string;
  let safe: { socketPath: string; process: ChildProcess };
  let unsafe: { socketPath: string; process: ChildProcess };
  const scanner = (socketPath: string, maxBytes = 20 * 1024 * 1024) => new ClamdScanner({ endpoint: { socketPath }, timeoutMs: 20_000, maxBytes, maxConcurrent: 3 });
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
