/**
 * AP-038C2A course archive validation (no database). Valid archives come from the real exporter
 * (assembleCourseArchive) with a synthetic, hash-valid course package; tampered ones are rebuilt from those entries
 * with the raw test ZIP builder (which, unlike the secure writer, can produce unsafe names and forged headers).
 * Archives exported from a real course are validated in the export suite (course-export.test.ts).
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { validateCourseArchive, ARCHIVE_VALIDATION_LIMITS, type ArchiveValidationReport } from '../../src/portability/archive-validation.js';
import { assembleCourseArchive } from '../../src/portability/course-archive.js';
import { EXCLUDED_DATA, PACKAGE_FORMAT, packageContentHash, type CoursePackage, type PackageActivity, type PackageAsset } from '../../src/portability/course-package.js';
import { makeDocx, makePdf, makePptx } from '../helpers/documents.js';
import { buildZip, type ZipSpec } from '../helpers/scorm.js';
import { zipEntries } from '../helpers/zip.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Doc = { name: string; title: string; format: 'pdf' | 'docx' | 'pptx'; bytes: Buffer };
const OFFICE: Doc[] = [
  { name: 'handout.pdf', title: 'Handout', format: 'pdf', bytes: makePdf([['Validation handout', 'Synthetic page.']]) },
  { name: 'notes.docx', title: 'Notes', format: 'docx', bytes: makeDocx(['Synthetic notes.']) },
  { name: 'slides.pptx', title: 'Slides', format: 'pptx', bytes: makePptx([['Synthetic slide']]) },
];

/** A course package the AP-038B validation accepts (hash included): one unit with a page and one activity per document. */
function coursePackage(docs: Doc[]): CoursePackage {
  const assets: PackageAsset[] = docs.map((doc, i) => ({ key: `asset-${i + 1}`, kind: 'document', fileName: doc.name, format: doc.format, byteSize: doc.bytes.length, sha256: sha(doc.bytes), bundled: false }));
  const version = (title: string, content: PackageActivity['working']['content']) => ({ title, content });
  const activities: PackageActivity[] = [
    { key: 'activity-1', type: 'page', position: 0, visible: true, folderKey: null, reviewStatus: 'approved', working: version('Welcome', { body: 'Synthetic welcome.' }), approved: version('Welcome', { body: 'Synthetic welcome.' }) },
    ...docs.map((doc, i): PackageActivity => {
      const content = { assetKey: `asset-${i + 1}`, fileName: doc.name, format: doc.format };
      return { key: `activity-${i + 2}`, type: 'file', position: i + 1, visible: true, folderKey: null, reviewStatus: 'approved', working: version(doc.title, content), approved: version(doc.title, content) };
    }),
  ];
  const course = { title: 'Archive validation fixture', description: 'Synthetic course.', units: [{ key: 'unit-1', title: 'Unit 1', summary: null, position: 0, visible: true, requiresUnitKeys: [], folders: [], activities }] };
  return {
    format: PACKAGE_FORMAT,
    formatVersion: 1,
    exportedAt: '2026-11-19T12:00:00.000Z',
    contentHash: packageContentHash(course, assets),
    source: { courseCode: 'ARC-V', courseStatus: 'published' },
    course,
    assets,
    warnings: assets.length ? [{ code: 'ASSET_NOT_BUNDLED', target: 'assets', detail: 'Document files are described but not included in this package.' }] : [],
    excludedData: EXCLUDED_DATA,
    counts: { units: 1, folders: 0, activities: activities.length, approvedActivities: activities.length, questions: 0, assets: assets.length },
  };
}

/** An archive written by the real exporter. */
async function exported(docs: Doc[] = OFFICE): Promise<Buffer> {
  const packaged = coursePackage(docs);
  const stored = new Map<string, Buffer>();
  const sources = new Map<string, string>();
  docs.forEach((doc, i) => {
    const key = randomUUID();
    stored.set(key, doc.bytes);
    sources.set(`asset-${i + 1}`, key);
  });
  return (await assembleCourseArchive(packaged, sources, { read: async (key) => stored.get(key)! })).archive;
}

/** The exported archive's entries, changed by `edit`, written again with the raw test builder. */
async function tampered(edit: (entries: ZipSpec[]) => ZipSpec[], docs: Doc[] = OFFICE): Promise<Buffer> {
  const entries = (await zipEntries(await exported(docs))).map((entry): ZipSpec => ({ name: entry.name, data: entry.data, method: 'deflate' }));
  return buildZip(edit(entries));
}
const dataOf = (entries: ZipSpec[], name: string) => entries.find((entry) => entry.name === name)!.data as Buffer;
const replace = (entries: ZipSpec[], name: string, data: Buffer | string) => entries.map((entry) => (entry.name === name ? { ...entry, data: Buffer.from(data) } : entry));
const editJson = (entries: ZipSpec[], name: string, change: (value: Record<string, any>) => void) => {
  const value = JSON.parse(dataOf(entries, name).toString('utf8')) as Record<string, any>;
  change(value);
  return replace(entries, name, JSON.stringify(value));
};

function codes(report: ArchiveValidationReport) {
  return report.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code);
}
async function invalid(bytes: Buffer, code: string) {
  const report = await validateCourseArchive(bytes);
  assert.equal(report.status, 'invalid', JSON.stringify(report.issues));
  assert.ok(codes(report).includes(code), `expected ${code}, got ${codes(report).join(', ')}`);
  assert.equal(report.preview, null, 'no preview of an invalid archive');
  assert.equal(report.imported, false);
  return report;
}

describe('course archive validation (AP-038C2A)', () => {
  it('accepts an exported archive with PDF, DOCX and PPTX and previews a new draft course', async () => {
    const report = await validateCourseArchive(await exported());
    assert.equal(report.status, 'valid', JSON.stringify(report.issues));
    assert.deepEqual([report.importMode, report.imported, report.manifest.format, report.manifest.formatVersion], ['new_draft_course', false, 'academiapath.course-archive', 1]);
    assert.equal(report.archive.entries, 5);
    const preview = report.preview!;
    assert.deepEqual([preview.title, preview.sourceCourseCode, preview.counts.units, preview.counts.activities, preview.counts.importableActivities], ['Archive validation fixture', 'ARC-V', 1, 4, 4]);
    assert.deepEqual(preview.documents.map((d) => [d.key, d.fileName, d.format, d.byteSize, d.activityKeys]), OFFICE.map((doc, i) => [`asset-${i + 1}`, doc.name, doc.format, doc.bytes.length, [`activity-${i + 2}`]]));
    assert.equal(preview.documentBytes, OFFICE.reduce((sum, doc) => sum + doc.bytes.length, 0));
    assert.deepEqual(preview.skipped, [], 'bundled documents are importable, unlike in the JSON-only import');
    assert.equal(preview.counts.skippedActivities, 0);
  });

  it('accepts an exported archive of an empty course', async () => {
    const report = await validateCourseArchive(await exported([]));
    assert.equal(report.status, 'valid', JSON.stringify(report.issues));
    assert.equal(report.archive.entries, 2);
    assert.deepEqual(report.preview!.documents, []);
  });

  it('refuses archives without the manifest or course.json, or with entries outside the format', async () => {
    await invalid(await tampered((e) => e.filter((x) => x.name !== 'academiapath-archive.json')), 'MANIFEST_MISSING');
    await invalid(await tampered((e) => e.filter((x) => x.name !== 'course.json')), 'PACKAGE_MISSING');
    await invalid(await tampered((e) => [...e, { name: 'run.sh', data: '#!/bin/sh\necho hi' }]), 'UNEXPECTED_ENTRY');
    await invalid(await tampered((e) => [...e, { name: 'assets/asset-1.exe', data: 'MZ' }]), 'UNEXPECTED_ENTRY');
    await invalid(buildZip([{ name: 'imsmanifest.xml', data: '<manifest/>' }]), 'MANIFEST_MISSING');
  });

  it('refuses an invalid or unsupported manifest', async () => {
    await invalid(await tampered((e) => replace(e, 'academiapath-archive.json', '{not json')), 'MANIFEST_INVALID');
    await invalid(await tampered((e) => editJson(e, 'academiapath-archive.json', (m) => (m.format = 'other.archive'))), 'FORMAT_UNSUPPORTED');
    const v2 = await invalid(await tampered((e) => editJson(e, 'academiapath-archive.json', (m) => (m.formatVersion = 2))), 'VERSION_UNSUPPORTED');
    assert.equal(v2.manifest.formatVersion, 2);
    await invalid(await tampered((e) => editJson(e, 'academiapath-archive.json', (m) => delete m.package)), 'MANIFEST_INVALID');
    await invalid(await tampered((e) => editJson(e, 'academiapath-archive.json', (m) => (m.assets[0].path = 'assets/../asset-1.pdf'))), 'MANIFEST_INVALID');
    await invalid(await tampered((e) => editJson(e, 'academiapath-archive.json', (m) => (m.assets[1].path = 'assets/notes.docx'))), 'MANIFEST_INVALID');
    await invalid(await tampered((e) => editJson(e, 'academiapath-archive.json', (m) => m.assets.push({ ...m.assets[0] }))), 'MANIFEST_INVALID');
    await invalid(await tampered((e) => editJson(e, 'academiapath-archive.json', (m) => (m.totals.assetBytes += 1))), 'MANIFEST_INVALID');
  });

  it('refuses a missing asset, changed file bytes, and wrong sizes or checksums', async () => {
    await invalid(await tampered((e) => e.filter((x) => x.name !== 'assets/asset-2.docx')), 'ASSET_MISSING');
    await invalid(
      await tampered((e) => {
        const bytes = Buffer.from(dataOf(e, 'assets/asset-1.pdf'));
        bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 0x01;
        return replace(e, 'assets/asset-1.pdf', bytes);
      }),
      'ASSET_INTEGRITY',
    );
    // A consistent lie in the manifest alone is caught against the course package's own record.
    await invalid(await tampered((e) => editJson(e, 'academiapath-archive.json', (m) => (m.assets[2].sha256 = '0'.repeat(64)))), 'ASSET_MISMATCH');
    await invalid(
      await tampered((e) =>
        editJson(e, 'academiapath-archive.json', (m) => {
          m.assets[0].byteSize += 1;
          m.totals.assetBytes += 1;
        }),
      ),
      'ASSET_MISMATCH',
    );
    // A ".pdf" that is not a PDF, in an archive whose manifest and package consistently describe it, is still refused.
    await invalid(await exported([{ ...OFFICE[0]!, bytes: Buffer.from('MZ not a pdf at all') }]), 'ASSET_TYPE_MISMATCH');
  });

  it('refuses duplicate, undeclared and case-colliding asset entries', async () => {
    await invalid(await tampered((e) => [...e, { name: 'assets/asset-9.pdf', data: OFFICE[0]!.bytes }]), 'UNDECLARED_ASSET');
    await invalid(await tampered((e) => [...e, { name: 'assets/asset-1.pdf', data: OFFICE[0]!.bytes }]), 'PATH_DUPLICATE');
    await invalid(await tampered((e) => [...e, { name: 'ASSETS/asset-1.pdf', data: OFFICE[0]!.bytes }]), 'PATH_COLLISION');
  });

  it('refuses unsafe paths, links and forged entries before reading any content', async () => {
    await invalid(await tampered((e) => [...e, { name: '../../evil.pdf', data: '%PDF-1.7' }]), 'PATH_TRAVERSAL');
    await invalid(await tampered((e) => [...e, { name: '/etc/evil.pdf', data: '%PDF-1.7' }]), 'PATH_ABSOLUTE');
    await invalid(await tampered((e) => [...e, { name: 'assets/link.pdf', data: '/etc/passwd', method: 'store', unixMode: 0o120777 }]), 'ENTRY_SYMLINK');
    await invalid(await tampered((e) => e.map((x) => (x.name === 'assets/asset-1.pdf' ? { ...x, crc: 0x12345678 } : x))), 'ENTRY_CORRUPT');
    await invalid(Buffer.from('this is not a zip file'), 'ARCHIVE_INVALID');
  });

  it('refuses ZIP bombs and archives above the size limits', async () => {
    await invalid(await tampered((e) => replace(e, 'assets/asset-1.pdf', Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(8 * 1024 * 1024)]))), 'ENTRY_EXPANSION_RATIO');
    await invalid(Buffer.alloc(ARCHIVE_VALIDATION_LIMITS.maxArchiveBytes + 1), 'ARCHIVE_TOO_LARGE');
    // Stored random data cannot be compressed: three 16 MB entries pass the per-entry checks but not the total budget.
    const big = randomBytes(16 * 1024 * 1024);
    const report = await validateCourseArchive(buildZip([{ name: 'academiapath-archive.json', data: '{}' }, { name: 'course.json', data: '{}' }, ...[1, 2, 3].map((n) => ({ name: `assets/asset-${n}.pdf`, data: big, method: 'store' as const }))]));
    assert.equal(report.status, 'invalid');
    assert.ok(codes(report).includes('ARCHIVE_TOO_LARGE'), codes(report).join(', '));
  });

  it('refuses an incorrect course.json: changed bytes, invalid package, or a different package than the manifest describes', async () => {
    await invalid(await tampered((e) => replace(e, 'course.json', Buffer.concat([dataOf(e, 'course.json'), Buffer.from(' ')]))), 'PACKAGE_INTEGRITY');
    // Rewritten consistently (manifest updated too), course.json must still pass the package validation.
    const rewrite = (change: (pkg: Record<string, any>) => void) =>
      tampered((e) => {
        const pkg = JSON.parse(dataOf(e, 'course.json').toString('utf8')) as Record<string, any>;
        change(pkg);
        const json = Buffer.from(JSON.stringify(pkg));
        return editJson(replace(e, 'course.json', json), 'academiapath-archive.json', (m) => {
          m.package.byteSize = json.length;
          m.package.sha256 = sha(json);
        });
      });
    await invalid(await rewrite((pkg) => (pkg.course.title = 'Changed after export')), 'PACKAGE_INVALID');
    await invalid(await rewrite((pkg) => (pkg.format = 'something.else')), 'PACKAGE_INVALID');
    await invalid(await rewrite((pkg) => (pkg.assets[0].bundled = true)), 'PACKAGE_INVALID');
  });
});
