/**
 * AP-038C1C portable course archive: one ZIP holding the AP-038A course package JSON unchanged, the bytes of every
 * document it lists, and a manifest that records each entry's size and SHA-256. Not exposed by any route yet (the
 * archive API is a later milestone, see docs/course-package-format.md).
 *
 *   academiapath-archive.json   manifest (format, course.json hash and size, every asset's path, size and SHA-256)
 *   course.json                 exactly the bytes GET /courses/{id}/export returns for the same snapshot
 *   assets/asset-1.pdf          one file per package asset, named `<asset key>.<format>` (never the uploaded name)
 *
 * The manifest is separate because course.json keeps `bundled: false` (AP-038B rejects packages that bundle files).
 *
 * Safety:
 * - Only the package's own assets are read, through the storage keys `buildCoursePackageWithSources` mapped for this
 *   course (documents of this course's activities). A reference to another course's document is never read: it stays
 *   an INVALID_REFERENCE warning in course.json, exactly as in the JSON export.
 * - Every file is checked against the database's byte size and SHA-256 before it is included. A missing, changed or
 *   unreadable file fails the whole archive (CourseArchiveError): an incomplete archive is never returned.
 * - At most ARCHIVE_MAX_BYTES (25 MB, provisional), checked from the database sizes before any file is read and again
 *   by the ZIP writer. Peak memory is about twice that: the verified file buffers plus the archive being written.
 * - Nothing is written to disk. Storage keys, paths and database identifiers never appear in the archive or in errors.
 * - Files are included as stored; they are not malware-scanned here (no scanner is connected, see AP-040).
 * - Deterministic: the same course content, `now` and file bytes give the same archive (fixed ZIP metadata, no
 *   timestamp in the manifest).
 */
import { createHash } from 'node:crypto';
import type { Database } from '../db/client.js';
import type { DocumentStorage } from '../documents/storage.js';
import { buildCoursePackageWithSources, serializePackage, type CoursePackage, type PackageSources } from './course-package.js';
import { writeZip, ZIP_MAX_BYTES, ZipWriteError, type ZipEntryInput } from './zip-writer.js';

export const ARCHIVE_FORMAT = 'academiapath.course-archive';
export const ARCHIVE_FORMAT_VERSION = 1;
/** Provisional cap, pending approval before the archive endpoint exists. */
export const ARCHIVE_MAX_BYTES = ZIP_MAX_BYTES;
export const ARCHIVE_MANIFEST_PATH = 'academiapath-archive.json';
export const ARCHIVE_PACKAGE_PATH = 'course.json';
/** Document formats a package asset can have (the database enum); anything else is refused. */
const ASSET_FORMATS = new Set(['pdf', 'docx', 'pptx']);

export type ArchiveAsset = { key: string; path: string; format: string; byteSize: number; sha256: string };
export type ArchiveManifest = {
  format: typeof ARCHIVE_FORMAT;
  formatVersion: number;
  package: { path: string; format: CoursePackage['format']; formatVersion: number; contentHash: string; byteSize: number; sha256: string };
  assets: ArchiveAsset[];
  totals: { assets: number; assetBytes: number };
};

export type CourseArchiveProblem = 'ASSET_MISSING' | 'ASSET_CORRUPT' | 'ASSET_INVALID' | 'STORAGE_UNAVAILABLE' | 'ARCHIVE_TOO_LARGE';

/** Why no archive was produced. `assetKey` is the package-local key (`asset-2`), never a storage key or path. */
export class CourseArchiveError extends Error {
  constructor(
    readonly problem: CourseArchiveProblem,
    message: string,
    readonly assetKey: string | null = null,
  ) {
    super(message);
    this.name = 'CourseArchiveError';
  }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const tooLarge = () => new CourseArchiveError('ARCHIVE_TOO_LARGE', `The course archive would exceed ${ARCHIVE_MAX_BYTES / (1024 * 1024)} MB.`);

/**
 * Assembles the archive of an already built package. `sources` must be the mapping returned with that package.
 * Throws CourseArchiveError (or the package's own COURSE_EXPORT_TOO_LARGE) instead of returning a partial archive.
 */
export async function assembleCourseArchive(packaged: CoursePackage, sources: PackageSources, storage: Pick<DocumentStorage, 'read'>): Promise<{ archive: Buffer; manifest: ArchiveManifest }> {
  const json = Buffer.from(serializePackage(packaged), 'utf8');
  // The archive holds exactly the package's assets, each with a known source.
  if (sources.size !== packaged.assets.length || packaged.assets.some((asset) => !sources.has(asset.key))) {
    throw new CourseArchiveError('ASSET_INVALID', 'The package assets and their sources do not match.');
  }
  const assetBytes = packaged.assets.reduce((sum, asset) => sum + asset.byteSize, 0);
  // Refuse before reading any file when the database sizes alone are already too large.
  if (json.length + assetBytes > ARCHIVE_MAX_BYTES) throw tooLarge();

  const assets: ArchiveAsset[] = [];
  const files: ZipEntryInput[] = [];
  for (const asset of packaged.assets) {
    if (!ASSET_FORMATS.has(asset.format) || !/^asset-[1-9][0-9]*$/.test(asset.key)) {
      throw new CourseArchiveError('ASSET_INVALID', 'A package asset has an unexpected key or format.', asset.key);
    }
    let bytes: Buffer;
    try {
      bytes = await storage.read(sources.get(asset.key)!);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') throw new CourseArchiveError('ASSET_MISSING', 'A document file of this course is missing from storage.', asset.key);
      throw new CourseArchiveError('STORAGE_UNAVAILABLE', 'A document file of this course could not be read.', asset.key);
    }
    if (bytes.length !== asset.byteSize || sha256(bytes) !== asset.sha256) {
      throw new CourseArchiveError('ASSET_CORRUPT', 'A document file of this course failed its integrity check.', asset.key);
    }
    const path = `assets/${asset.key}.${asset.format}`;
    assets.push({ key: asset.key, path, format: asset.format, byteSize: asset.byteSize, sha256: asset.sha256 });
    files.push({ path, data: bytes });
  }

  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    package: { path: ARCHIVE_PACKAGE_PATH, format: packaged.format, formatVersion: packaged.formatVersion, contentHash: packaged.contentHash, byteSize: json.length, sha256: sha256(json) },
    assets,
    totals: { assets: assets.length, assetBytes },
  };
  try {
    const archive = await writeZip([
      { path: ARCHIVE_MANIFEST_PATH, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'), compress: true },
      { path: ARCHIVE_PACKAGE_PATH, data: json, compress: true },
      ...files,
    ]);
    return { archive, manifest };
  } catch (error) {
    if (error instanceof ZipWriteError && error.problem === 'ARCHIVE_TOO_LARGE') throw tooLarge();
    throw error;
  }
}

/**
 * Builds one course's archive: the package from one consistent read-only snapshot (as the JSON export does), then the
 * files, read after the snapshot's transaction has ended. The caller checks permissions (`content.export`).
 */
export async function buildCourseArchive(
  db: Database,
  courseId: string,
  storage: Pick<DocumentStorage, 'exists' | 'read'>,
  now: Date,
): Promise<{ archive: Buffer; manifest: ArchiveManifest; packaged: CoursePackage }> {
  const { packaged, sources } = await db.transaction((tx) => buildCoursePackageWithSources(tx, courseId, storage, now), { isolationLevel: 'repeatable read', accessMode: 'read only' });
  return { ...(await assembleCourseArchive(packaged, sources, storage)), packaged };
}
