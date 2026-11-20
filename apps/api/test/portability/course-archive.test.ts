/**
 * AP-038C1C course archive assembly (no database): the archive layout and manifest, integrity checks against the
 * package's sizes and SHA-256 hashes, fail-closed behaviour for missing, changed or unreadable files, the size cap,
 * determinism and the absence of storage keys or local paths. Packages and files are synthetic and in memory.
 * Archives built from real courses are tested with the export suite (course-export.test.ts).
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_MAX_BYTES,
  assembleCourseArchive,
  CourseArchiveError,
  type ArchiveManifest,
  type CourseArchiveProblem,
} from '../../src/portability/course-archive.js';
import { EXCLUDED_DATA, PACKAGE_FORMAT, serializePackage, type CoursePackage, type PackageAsset } from '../../src/portability/course-package.js';
import { scanArchive, type ArchiveProblem } from '../../src/scorm/archive.js';
import { makeDocx, makePdf, makePptx } from '../helpers/documents.js';
import { zipEntries as entries } from '../helpers/zip.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A synthetic package with the given files as assets, plus the storage that holds them under random keys. */
function fixture(files: Array<{ format: 'pdf' | 'docx' | 'pptx'; bytes: Buffer; fileName?: string }>) {
  const stored = new Map<string, Buffer>();
  const sources = new Map<string, string>();
  const assets: PackageAsset[] = files.map((file, index) => {
    const key = `asset-${index + 1}`;
    const storageKey = randomUUID();
    stored.set(storageKey, file.bytes);
    sources.set(key, storageKey);
    return { key, kind: 'document', fileName: file.fileName ?? `../../${key}.${file.format}`, format: file.format, byteSize: file.bytes.length, sha256: sha(file.bytes), bundled: false };
  });
  const packaged = {
    format: PACKAGE_FORMAT,
    formatVersion: 1,
    exportedAt: '2026-11-19T12:00:00.000Z',
    contentHash: `sha256:${'0'.repeat(64)}`,
    source: { courseCode: 'ARC-1', courseStatus: 'published' },
    course: { title: 'Archive fixture', description: null, units: [] },
    assets,
    warnings: assets.length ? [{ code: 'ASSET_NOT_BUNDLED', target: 'assets', detail: 'Described only.' }] : [],
    excludedData: EXCLUDED_DATA,
    counts: { units: 0, folders: 0, activities: 0, approvedActivities: 0, questions: 0, assets: assets.length },
  } as unknown as CoursePackage;
  const reads: string[] = [];
  const storage = {
    async read(key: string) {
      reads.push(key);
      const bytes = stored.get(key);
      if (!bytes) throw Object.assign(new Error(`ENOENT: no such file, open '/srv/private/${key}'`), { code: 'ENOENT' });
      return bytes;
    },
  };
  return { packaged, sources, stored, storage, reads };
}

async function fails(promise: Promise<unknown>, problem: CourseArchiveProblem, assetKey: string | null, secrets: string[] = []) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CourseArchiveError, String(error));
    assert.equal(error.problem, problem);
    assert.equal(error.assetKey, assetKey);
    for (const secret of [...secrets, '/srv/private']) assert.ok(!error.message.includes(secret), 'no storage key or path in the error');
    return true;
  });
}

const OFFICE = [
  { format: 'pdf' as const, bytes: makePdf([['Archive handout', 'Synthetic page one.']]) },
  { format: 'docx' as const, bytes: makeDocx(['Synthetic paragraph.']) },
  { format: 'pptx' as const, bytes: makePptx([['Synthetic slide']]) },
];

describe('course archive assembly (AP-038C1C)', () => {
  it('a course without documents: the manifest and course.json only, accepted by the archive scanner', async () => {
    const { packaged, sources, storage } = fixture([]);
    const { archive, manifest } = await assembleCourseArchive(packaged, sources, storage);
    const read = await entries(archive);
    assert.deepEqual(read.map((entry) => entry.name), ['academiapath-archive.json', 'course.json']);
    assert.deepEqual(manifest.totals, { assets: 0, assetBytes: 0 });
    assert.deepEqual(JSON.parse(read[0]!.data.toString('utf8')), manifest);
    const problems: ArchiveProblem[] = [];
    assert.equal((await scanArchive(archive, { error: (problem) => problems.push(problem) })).safe, true);
    assert.deepEqual(problems, []);
  });

  it('PDF, DOCX and PPTX: each file under a server-controlled path, its bytes matching the manifest; course.json unchanged', async () => {
    const { packaged, sources, storage } = fixture(OFFICE);
    const { archive, manifest } = await assembleCourseArchive(packaged, sources, storage);
    const read = await entries(archive);
    assert.deepEqual(read.map((entry) => entry.name), ['academiapath-archive.json', 'course.json', 'assets/asset-1.pdf', 'assets/asset-2.docx', 'assets/asset-3.pptx']);
    const stored = JSON.parse(read[0]!.data.toString('utf8')) as ArchiveManifest;
    assert.deepEqual(stored, manifest);
    assert.equal(stored.format, ARCHIVE_FORMAT);
    assert.equal(stored.formatVersion, 1);
    // course.json is byte for byte the AP-038A serialization, and the manifest records its size and hash.
    const json = read[1]!.data;
    assert.ok(json.equals(Buffer.from(serializePackage(packaged), 'utf8')));
    assert.deepEqual(stored.package, { path: 'course.json', format: PACKAGE_FORMAT, formatVersion: 1, contentHash: packaged.contentHash, byteSize: json.length, sha256: sha(json) });
    for (const [index, asset] of stored.assets.entries()) {
      const entry = read.find((candidate) => candidate.name === asset.path)!;
      assert.equal(entry.data.length, asset.byteSize);
      assert.equal(sha(entry.data), asset.sha256, `${asset.path}: bytes match the manifest`);
      assert.ok(entry.data.equals(OFFICE[index]!.bytes));
    }
    assert.deepEqual(stored.totals, { assets: 3, assetBytes: OFFICE.reduce((sum, file) => sum + file.bytes.length, 0) });
    assert.ok(read.every((entry) => !entry.name.includes('..')), 'the uploaded file name (here "../../…") is never a path');
    const problems: ArchiveProblem[] = [];
    assert.equal((await scanArchive(archive, { error: (problem) => problems.push(problem) })).safe, true);
    assert.deepEqual(problems, []);
  });

  it('is deterministic and holds no storage key, local path or identifier', async () => {
    const { packaged, sources, storage, stored } = fixture(OFFICE);
    const first = (await assembleCourseArchive(packaged, sources, storage)).archive;
    assert.ok(first.equals((await assembleCourseArchive(packaged, sources, storage)).archive), 'identical inputs, identical archive');
    for (const entry of await entries(first)) {
      for (const secret of [...stored.keys(), tmpdir(), process.cwd()]) assert.ok(!entry.data.includes(Buffer.from(secret)), `${entry.name}: no ${secret}`);
    }
  });

  it('fails closed: a missing, resized, altered or unreadable file stops the whole archive', async () => {
    const missing = fixture(OFFICE);
    missing.stored.delete(missing.sources.get('asset-2')!);
    await fails(assembleCourseArchive(missing.packaged, missing.sources, missing.storage), 'ASSET_MISSING', 'asset-2', [...missing.sources.values()]);

    const resized = fixture(OFFICE);
    const key3 = resized.sources.get('asset-3')!;
    resized.stored.set(key3, Buffer.concat([resized.stored.get(key3)!, Buffer.from('x')]));
    await fails(assembleCourseArchive(resized.packaged, resized.sources, resized.storage), 'ASSET_CORRUPT', 'asset-3');

    const altered = fixture(OFFICE);
    const key1 = altered.sources.get('asset-1')!;
    const changed = Buffer.from(altered.stored.get(key1)!);
    changed[changed.length - 2] = changed[changed.length - 2]! ^ 0x01;
    altered.stored.set(key1, changed);
    await fails(assembleCourseArchive(altered.packaged, altered.sources, altered.storage), 'ASSET_CORRUPT', 'asset-1');

    const unreadable = fixture(OFFICE);
    const failing = { read: async () => Promise.reject(Object.assign(new Error('EIO: i/o error, read /mnt/documents/x'), { code: 'EIO' })) };
    await fails(assembleCourseArchive(unreadable.packaged, unreadable.sources, failing), 'STORAGE_UNAVAILABLE', 'asset-1', ['/mnt/documents']);
  });

  it(`refuses an archive above ${ARCHIVE_MAX_BYTES / (1024 * 1024)} MB: before reading files, or when writing it`, async () => {
    const huge = fixture([{ format: 'pdf', bytes: Buffer.alloc(16) }]);
    (huge.packaged.assets[0] as { byteSize: number }).byteSize = ARCHIVE_MAX_BYTES;
    await fails(assembleCourseArchive(huge.packaged, huge.sources, huge.storage), 'ARCHIVE_TOO_LARGE', null);
    assert.deepEqual(huge.reads, [], 'no file was read');
    // Within the cap by the database sizes, but over it once the ZIP headers and the manifest are added.
    const json = Buffer.byteLength(serializePackage(fixture([{ format: 'pdf', bytes: Buffer.alloc(1) }]).packaged));
    const edge = fixture([{ format: 'pdf', bytes: randomBytes(ARCHIVE_MAX_BYTES - json - 64) }]);
    await fails(assembleCourseArchive(edge.packaged, edge.sources, edge.storage), 'ARCHIVE_TOO_LARGE', null);
  });

  it('refuses inconsistent input: assets without sources, sources for unknown assets, unexpected formats', async () => {
    const extra = fixture(OFFICE);
    const sources = new Map(extra.sources);
    sources.set('asset-9', randomUUID());
    await fails(assembleCourseArchive(extra.packaged, sources, extra.storage), 'ASSET_INVALID', null);
    const lacking = fixture(OFFICE);
    const partial = new Map(lacking.sources);
    partial.delete('asset-2');
    await fails(assembleCourseArchive(lacking.packaged, partial, lacking.storage), 'ASSET_INVALID', null);
    const odd = fixture([{ format: 'pdf', bytes: Buffer.from('%PDF-1.7') }]);
    (odd.packaged.assets[0] as { format: string }).format = 'exe';
    await fails(assembleCourseArchive(odd.packaged, odd.sources, odd.storage), 'ASSET_INVALID', 'asset-1');
    assert.deepEqual(odd.reads, [], 'nothing is read for an invalid asset');
  });
});
