/**
 * AP-038C1B ZIP writer (no database): valid archives read back by yauzl and by the inspectors' scanner, entry order,
 * empty files, deterministic bytes and fixed metadata, CRC integrity, unsafe and duplicate names, the 25 MB limit, and
 * library failures that must never yield a partial archive.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { describe, it, mock } from 'node:test';
import { crc32 } from 'node:zlib';
import yauzl, { type Entry } from 'yauzl';
import yazl from 'yazl';
import { writeZip, ZIP_MAX_BYTES, ZIP_MAX_ENTRIES, ZipWriteError, type ZipEntryInput, type ZipWriteProblem } from '../../src/portability/zip-writer.js';
import { scanArchive, type ArchiveProblem } from '../../src/scorm/archive.js';

type ReadEntry = { name: string; data: Buffer; entry: Entry };

/** Every entry in archive order, with its bytes (yauzl checks each entry's real size against its header). */
function readZip(bytes: Buffer): Promise<ReadEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const out: ReadEntry[] = [];
      zip.on('error', reject);
      zip.on('end', () => resolve(out));
      zip.on('entry', (entry: Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError);
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            out.push({ name: entry.fileName, data: Buffer.concat(chunks), entry });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function scan(bytes: Buffer) {
  const problems: ArchiveProblem[] = [];
  const result = await scanArchive(bytes, { error: (problem) => problems.push(problem) });
  return { result, problems };
}

async function refused(entries: readonly ZipEntryInput[], problem: ZipWriteProblem) {
  await assert.rejects(writeZip(entries), (error: unknown) => error instanceof ZipWriteError && error.problem === problem);
}

const json = Buffer.from(JSON.stringify({ format: 'example', items: Array.from({ length: 50 }, (_, n) => ({ n, text: `Item ${n}` })) }));
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(4096)]);
const ENTRIES: ZipEntryInput[] = [
  { path: 'manifest.json', data: Buffer.from('{"format":"example"}'), compress: true },
  { path: 'course.json', data: json, compress: true },
  { path: 'assets/asset-1.pdf', data: pdf },
  { path: 'assets/empty.txt', data: Buffer.alloc(0) },
];

describe('ZIP writer (AP-038C1B)', () => {
  it('writes every entry, in the given order, with its exact bytes; the archive passes the inspectors\' scanner', async () => {
    const bytes = await writeZip(ENTRIES);
    const read = await readZip(bytes);
    assert.deepEqual(read.map((entry) => entry.name), ENTRIES.map((entry) => entry.path));
    for (const [index, entry] of read.entries()) {
      assert.ok(entry.data.equals(ENTRIES[index]!.data), `${entry.name}: same bytes`);
      assert.equal(entry.entry.crc32 >>> 0, crc32(ENTRIES[index]!.data) >>> 0, `${entry.name}: CRC-32 recorded`);
      assert.equal(entry.entry.compressionMethod, ENTRIES[index]!.compress ? 8 : 0, `${entry.name}: compression as requested`);
    }
    assert.equal(read[3]!.entry.uncompressedSize, 0, 'an empty file is a valid entry');
    const { result, problems } = await scan(bytes);
    assert.deepEqual(problems, []);
    assert.equal(result.safe, true);
    assert.equal(result.fileCount, ENTRIES.length);
    assert.equal(result.uncompressedBytes, ENTRIES.reduce((sum, entry) => sum + entry.data.length, 0));
  });

  it('is deterministic: the same entries give the same bytes, with fixed metadata and nothing from the server', async () => {
    const first = await writeZip(ENTRIES);
    assert.ok(first.equals(await writeZip(ENTRIES)), 'identical archives');
    const reordered = await writeZip([...ENTRIES].reverse());
    assert.ok(!first.equals(reordered));
    assert.deepEqual((await readZip(reordered)).map((entry) => entry.name), ENTRIES.map((entry) => entry.path).reverse(), 'order follows the input');
    for (const { entry } of await readZip(first)) {
      assert.equal(entry.getLastModDate().getTime(), new Date(1980, 0, 1).getTime(), 'fixed timestamp');
      assert.equal((entry.externalFileAttributes >>> 16) & 0o777, 0o644, 'fixed permissions');
      assert.equal(entry.extraFields.length, 0, 'no extra fields (no extended timestamps or owner ids)');
      assert.equal(entry.fileComment.length, 0, 'no file comment');
    }
    for (const local of [process.cwd(), tmpdir(), import.meta.dirname]) assert.ok(!first.includes(Buffer.from(local)), 'no local path');
  });

  it('records each entry\'s CRC-32, so a damaged or truncated archive is detected by the scanner', async () => {
    const bytes = await writeZip(ENTRIES);
    const damaged = Buffer.from(bytes);
    const at = damaged.indexOf(pdf.subarray(100, 132));
    assert.ok(at > 0, 'the stored PDF bytes are in the archive');
    damaged[at] = damaged[at]! ^ 0xff;
    assert.ok((await scan(damaged)).problems.includes('ENTRY_CORRUPT'));
    assert.ok((await scan(bytes.subarray(0, bytes.length - 30))).problems.includes('ARCHIVE_INVALID'));
  });

  it('refuses duplicate paths, including names that differ only in case and a file that is also a folder', async () => {
    const data = Buffer.from('x');
    await refused([{ path: 'a.txt', data }, { path: 'a.txt', data }], 'DUPLICATE_ENTRY');
    await refused([{ path: 'Course.json', data }, { path: 'course.JSON', data }], 'DUPLICATE_ENTRY');
    await refused([{ path: 'assets', data }, { path: 'assets/a.pdf', data }], 'DUPLICATE_ENTRY');
    await refused([{ path: 'assets/a.pdf', data }, { path: 'Assets', data }], 'DUPLICATE_ENTRY');
  });

  it('refuses unsafe or invalid names (traversal, absolute, backslashes, hidden, empty segments, non-ASCII, too long or deep) and non-buffer content', async () => {
    const data = Buffer.from('x');
    const names = ['', '../evil.txt', 'a/../../evil.txt', '..', './a.txt', '/etc/passwd', 'C:/evil.txt', 'a\\b.txt', '.hidden', 'a//b.txt', 'a/', 'ü.txt', 'a b.txt', 'a:b.txt', `${'a'.repeat(101)}.txt`, Array(9).fill('d').join('/')];
    for (const path of names) await refused([{ path, data }], 'INVALID_ENTRY_NAME');
    await refused([{ path: 'a.txt', data: 'text' as unknown as Buffer }], 'INVALID_ENTRY_DATA');
    await refused(Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, n) => ({ path: `f${n}`, data: Buffer.alloc(0) })), 'TOO_MANY_ENTRIES');
  });

  it(`refuses an archive above ${ZIP_MAX_BYTES / (1024 * 1024)} MB, before writing (stored) or while writing (compressed)`, async () => {
    const oversized = randomBytes(ZIP_MAX_BYTES + 1024);
    await refused([{ path: 'big.bin', data: oversized }], 'ARCHIVE_TOO_LARGE');
    // Random data does not compress, so the deflated entry still crosses the limit while the archive is written.
    await refused([{ path: 'big.bin', data: oversized, compress: true }], 'ARCHIVE_TOO_LARGE');
    const justUnder = await writeZip([{ path: 'big.bin', data: randomBytes(ZIP_MAX_BYTES - 1024) }]);
    assert.ok(justUnder.length <= ZIP_MAX_BYTES);
  });

  it('turns a library failure into an error and never returns a partial archive', async () => {
    const failing = mock.method(yazl.ZipFile.prototype, 'addBuffer', function (this: yazl.ZipFile) {
      throw new Error('simulated failure with /srv/private/storage-key in the message');
    });
    try {
      await assert.rejects(writeZip(ENTRIES), (error: unknown) => {
        assert.ok(error instanceof ZipWriteError);
        assert.equal(error.problem, 'ZIP_WRITE_FAILED');
        assert.ok(!error.message.includes('/srv/private'), 'library details are not passed on');
        return true;
      });
    } finally {
      failing.mock.restore();
    }
    assert.ok((await writeZip(ENTRIES)).length > 0, 'the writer works again afterwards');
  });
});
