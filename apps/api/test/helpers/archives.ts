/**
 * Synthetic AcademiaPath course archives for the archive validation, preview and import tests (AP-038C2A-C).
 * Valid archives come from the real exporter (assembleCourseArchive) with a synthetic, hash-valid course package;
 * tampered ones are rebuilt from those entries with the raw test ZIP builder (which, unlike the secure writer, can
 * produce unsafe names and forged headers).
 */
import { createHash, randomUUID } from 'node:crypto';
import { assembleCourseArchive } from '../../src/portability/course-archive.js';
import { EXCLUDED_DATA, PACKAGE_FORMAT, packageContentHash, type CoursePackage, type PackageActivity, type PackageAsset } from '../../src/portability/course-package.js';
import { makeDocx, makePdf, makePptx } from './documents.js';
import { buildZip, type ZipSpec } from './scorm.js';
import { zipEntries } from './zip.js';

export const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export type Doc = { name: string; title: string; format: 'pdf' | 'docx' | 'pptx'; bytes: Buffer };
export const OFFICE: Doc[] = [
  { name: 'handout.pdf', title: 'Handout', format: 'pdf', bytes: makePdf([['Validation handout', 'Synthetic page.']]) },
  { name: 'notes.docx', title: 'Notes', format: 'docx', bytes: makeDocx(['Synthetic notes.']) },
  { name: 'slides.pptx', title: 'Slides', format: 'pptx', bytes: makePptx([['Synthetic slide']]) },
];

/** A course package the AP-038B validation accepts (hash included): one unit with a page and one activity per document. */
export function coursePackage(docs: Doc[]): CoursePackage {
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
export async function exported(docs: Doc[] = OFFICE): Promise<Buffer> {
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
export async function tampered(edit: (entries: ZipSpec[]) => ZipSpec[], docs: Doc[] = OFFICE): Promise<Buffer> {
  const entries = (await zipEntries(await exported(docs))).map((entry): ZipSpec => ({ name: entry.name, data: entry.data, method: 'deflate' }));
  return buildZip(edit(entries));
}
export const dataOf = (entries: ZipSpec[], name: string) => entries.find((entry) => entry.name === name)!.data as Buffer;
export const replace = (entries: ZipSpec[], name: string, data: Buffer | string) => entries.map((entry) => (entry.name === name ? { ...entry, data: Buffer.from(data) } : entry));
export const editJson = (entries: ZipSpec[], name: string, change: (value: Record<string, any>) => void) => {
  const value = JSON.parse(dataOf(entries, name).toString('utf8')) as Record<string, any>;
  change(value);
  return replace(entries, name, JSON.stringify(value));
};
