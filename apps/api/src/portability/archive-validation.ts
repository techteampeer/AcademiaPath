/**
 * AP-038C2A: validates an untrusted AcademiaPath course archive (the ZIP made by AP-038C1C, see course-archive.ts) and
 * previews what an import would create. Nothing is imported, stored or written: the archive is read in memory only.
 *
 * Checks, in order (later checks run only when the earlier ones leave something trustworthy to check):
 * 1. Archive safety, through the inspectors' scanner (`scanArchive`): valid ZIP, every entry's real size and CRC-32,
 *    no traversal, absolute paths, duplicates or case collisions, links, special or encrypted entries, unsupported
 *    compression, expansion ratio and entry limits. Plus this format's own limits (ARCHIVE_VALIDATION_LIMITS).
 * 2. Layout: exactly `academiapath-archive.json`, `course.json` and `assets/<asset key>.<pdf|docx|pptx>`; anything else
 *    is refused.
 * 3. Manifest: format `academiapath.course-archive`, version 1, and its structure.
 * 4. course.json: the manifest's size and SHA-256, then the AP-038B package validation (`analyzePackage`, which also
 *    verifies the package's own content hash), and agreement between the manifest and the package.
 * 5. Assets: every declared asset present exactly once, nothing undeclared, sizes and SHA-256 equal to the manifest and
 *    the package, and a file signature matching its format.
 *
 * Content is never executed or fetched: links in course.json are data, and document files are only hashed and their
 * first bytes compared. Full document validation (and malware scanning, AP-040) belongs to the later import, which
 * creates a NEW draft course and never touches an existing one.
 */
import { createHash } from 'node:crypto';
import { scanArchive, type ArchiveProblem } from '../scorm/archive.js';
import { ARCHIVE_FORMAT, ARCHIVE_FORMAT_VERSION, ARCHIVE_MANIFEST_PATH, ARCHIVE_MAX_BYTES, ARCHIVE_PACKAGE_PATH } from './course-archive.js';
import { analyzePackage, IMPORT_LIMITS, IMPORT_MAX_BYTES, type ImportPreview } from './course-import.js';
import { PACKAGE_FORMAT } from './course-package.js';

export const ARCHIVE_VALIDATION_LIMITS = {
  /** The export's provisional cap (AP-038C1C). */
  maxArchiveBytes: ARCHIVE_MAX_BYTES,
  maxManifestBytes: 1024 * 1024,
  /** course.json: the JSON import's own limit. */
  maxPackageBytes: IMPORT_MAX_BYTES,
  maxAssets: IMPORT_LIMITS.assets,
  /** Everything decompressed and kept in memory: the files plus course.json. */
  maxUncompressedBytes: ARCHIVE_MAX_BYTES + IMPORT_MAX_BYTES,
  maxIssues: 200,
} as const;

const ASSET_PATH = /^assets\/(asset-[1-9][0-9]{0,5})\.(pdf|docx|pptx)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SIGNATURES: Record<string, Buffer> = { pdf: Buffer.from('%PDF-'), docx: Buffer.from([0x50, 0x4b, 0x03, 0x04]), pptx: Buffer.from([0x50, 0x4b, 0x03, 0x04]) };

export type ArchiveIssue = { severity: 'error' | 'warning'; code: string; message: string; path: string | null };
export type ArchiveValidationReport = {
  status: 'valid' | 'valid_with_warnings' | 'invalid';
  /** Always a new draft course: an archive never updates or overwrites an existing course. */
  importMode: 'new_draft_course';
  imported: false;
  archive: { byteSize: number; entries: number; uncompressedBytes: number | null };
  manifest: { format: string | null; formatVersion: number | null };
  /** What an import would create; null when the archive is not usable. */
  preview: {
    title: string | null;
    description: string | null;
    sourceCourseCode: string | null;
    exportedAt: string | null;
    counts: ImportPreview['counts'];
    documents: Array<{ key: string; fileName: string; format: string; byteSize: number; sha256: string; activityKeys: string[] }>;
    documentBytes: number;
    skipped: ImportPreview['skipped'];
    requiresDueDate: boolean;
    packageWarnings: ImportPreview['packageWarnings'];
  } | null;
  issues: ArchiveIssue[];
  issueCount: number;
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min;

const ARCHIVE_MESSAGES: Record<ArchiveProblem, string> = {
  ARCHIVE_INVALID: 'The file is not a readable ZIP archive.',
  ARCHIVE_TOO_MANY_ENTRIES: 'The archive has too many entries.',
  ARCHIVE_TOO_LARGE: 'The archive expands beyond the size limit.',
  PATH_TRAVERSAL: 'An entry name climbs out of the archive.',
  PATH_ABSOLUTE: 'An entry name is an absolute path.',
  PATH_INVALID: 'An entry name is not allowed.',
  PATH_DUPLICATE: 'Two entries have the same name.',
  PATH_COLLISION: 'Two entry names differ only in letter case or Unicode form.',
  ENTRY_ENCRYPTED: 'An entry is encrypted.',
  ENTRY_SYMLINK: 'An entry is a symbolic link.',
  ENTRY_SPECIAL_FILE: 'An entry is a special file.',
  ENTRY_COMPRESSION_UNSUPPORTED: 'An entry uses an unsupported compression method.',
  ENTRY_TOO_LARGE: 'An entry is larger than the limit.',
  ENTRY_EXPANSION_RATIO: 'An entry expands far more than real files do (possible ZIP bomb).',
  ENTRY_CORRUPT: 'An entry is damaged: its size or CRC-32 does not match.',
};

class Issues {
  readonly list: ArchiveIssue[] = [];
  error(code: string, message: string, path: string | null = null) {
    this.list.push({ severity: 'error', code, message, path });
  }
  warn(code: string, message: string, path: string | null = null) {
    this.list.push({ severity: 'warning', code, message, path });
  }
  get failed() {
    return this.list.some((issue) => issue.severity === 'error');
  }
}

type ManifestAsset = { key: string; path: string; format: string; byteSize: number; sha256: string };
type Manifest = {
  format: unknown;
  formatVersion: unknown;
  package: { path: string; format: string; formatVersion: number; contentHash: string; byteSize: number; sha256: string };
  assets: ManifestAsset[];
  totals: { assets: number; assetBytes: number };
};

/** Structure of a version 1 manifest (format and version are checked by the caller first). */
function readManifest(raw: unknown, issues: Issues): Manifest | null {
  const bad = (field: string, message: string) => (issues.error('MANIFEST_INVALID', message, `${ARCHIVE_MANIFEST_PATH}: ${field}`), null);
  if (!isObject(raw)) return bad('$', 'The manifest is not a JSON object.');
  const pkg = raw.package;
  if (!isObject(pkg)) return bad('package', 'The manifest has no package description.');
  if (pkg.path !== ARCHIVE_PACKAGE_PATH || pkg.format !== PACKAGE_FORMAT || !isCount(pkg.formatVersion, 1) || typeof pkg.contentHash !== 'string' || !isCount(pkg.byteSize, 1) || typeof pkg.sha256 !== 'string' || !SHA256.test(pkg.sha256)) {
    return bad('package', 'The package description is incomplete or invalid.');
  }
  if (!Array.isArray(raw.assets)) return bad('assets', 'The manifest has no asset list.');
  if (raw.assets.length > ARCHIVE_VALIDATION_LIMITS.maxAssets) return bad('assets', `The manifest lists more than ${ARCHIVE_VALIDATION_LIMITS.maxAssets} assets.`);
  const assets: ManifestAsset[] = [];
  const keys = new Set<string>();
  for (const [index, asset] of raw.assets.entries()) {
    const at = `assets[${index}]`;
    if (!isObject(asset) || typeof asset.key !== 'string' || typeof asset.format !== 'string' || typeof asset.path !== 'string' || !isCount(asset.byteSize, 1) || typeof asset.sha256 !== 'string' || !SHA256.test(asset.sha256)) {
      return bad(at, 'An asset description is incomplete or invalid.');
    }
    const match = ASSET_PATH.exec(asset.path);
    // The only accepted path is the canonical one the exporter writes.
    if (!match || match[1] !== asset.key || match[2] !== asset.format) return bad(at, 'An asset path is not the canonical assets/<key>.<format>.');
    if (keys.has(asset.key)) return bad(at, 'An asset key is listed twice.');
    keys.add(asset.key);
    assets.push({ key: asset.key, path: asset.path, format: asset.format, byteSize: asset.byteSize, sha256: asset.sha256 });
  }
  const totals = raw.totals;
  if (!isObject(totals) || totals.assets !== assets.length || totals.assetBytes !== assets.reduce((sum, asset) => sum + asset.byteSize, 0)) {
    return bad('totals', 'The totals do not match the asset list.');
  }
  return {
    format: raw.format,
    formatVersion: raw.formatVersion,
    package: { path: pkg.path, format: pkg.format, formatVersion: pkg.formatVersion, contentHash: pkg.contentHash, byteSize: pkg.byteSize, sha256: pkg.sha256 },
    assets,
    totals: { assets: totals.assets, assetBytes: totals.assetBytes as number },
  };
}

function parseJson(bytes: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false };
  }
}

/** Validates one archive held in memory. Never throws for bad input: every problem is an issue in the report. */
export async function validateCourseArchive(bytes: Buffer): Promise<ArchiveValidationReport> {
  const issues = new Issues();
  const report: ArchiveValidationReport = {
    status: 'invalid',
    importMode: 'new_draft_course',
    imported: false,
    archive: { byteSize: bytes.length, entries: 0, uncompressedBytes: null },
    manifest: { format: null, formatVersion: null },
    preview: null,
    issues: [],
    issueCount: 0,
  };
  const finish = () => {
    report.issues = issues.list.slice(0, ARCHIVE_VALIDATION_LIMITS.maxIssues);
    report.issueCount = issues.list.length;
    report.status = issues.failed ? 'invalid' : issues.list.length ? 'valid_with_warnings' : 'valid';
    if (issues.failed) report.preview = null;
    return report;
  };

  if (bytes.length > ARCHIVE_VALIDATION_LIMITS.maxArchiveBytes) {
    issues.error('ARCHIVE_TOO_LARGE', `The archive is larger than ${ARCHIVE_VALIDATION_LIMITS.maxArchiveBytes / (1024 * 1024)} MB.`);
    return finish();
  }

  // 1. Safety. Only the expected entries are kept, within one memory budget.
  let keptBytes = 0;
  let overBudget = false;
  const scan = await scanArchive(
    bytes,
    { error: (problem, details) => issues.error(problem, ARCHIVE_MESSAGES[problem], details?.path ?? null) },
    {
      keep: (path, size) => {
        const expected = path === ARCHIVE_MANIFEST_PATH ? size <= ARCHIVE_VALIDATION_LIMITS.maxManifestBytes : path === ARCHIVE_PACKAGE_PATH ? size <= ARCHIVE_VALIDATION_LIMITS.maxPackageBytes : ASSET_PATH.test(path);
        if (!expected) return false;
        if (keptBytes + size > ARCHIVE_VALIDATION_LIMITS.maxUncompressedBytes) {
          overBudget = true;
          return false;
        }
        keptBytes += size;
        return true;
      },
    },
  );
  report.archive.entries = scan.fileCount;
  report.archive.uncompressedBytes = scan.uncompressedBytes;
  if (overBudget) issues.error('ARCHIVE_TOO_LARGE', 'The archive expands beyond the size limit.');
  if (!scan.safe || overBudget) return finish();

  // 2. Layout: required entries, nothing else.
  for (const path of scan.files.keys()) {
    if (path !== ARCHIVE_MANIFEST_PATH && path !== ARCHIVE_PACKAGE_PATH && !ASSET_PATH.test(path)) issues.error('UNEXPECTED_ENTRY', 'The archive holds a file that is not part of the format.', path);
  }
  const manifestBytes = scan.kept.get(ARCHIVE_MANIFEST_PATH);
  const packageBytes = scan.kept.get(ARCHIVE_PACKAGE_PATH);
  if (!scan.files.has(ARCHIVE_MANIFEST_PATH)) issues.error('MANIFEST_MISSING', 'The archive has no academiapath-archive.json: it is not an AcademiaPath course archive.');
  else if (!manifestBytes) issues.error('MANIFEST_TOO_LARGE', 'The archive manifest is larger than the limit.', ARCHIVE_MANIFEST_PATH);
  if (!scan.files.has(ARCHIVE_PACKAGE_PATH)) issues.error('PACKAGE_MISSING', 'The archive has no course.json.');
  else if (!packageBytes) issues.error('PACKAGE_TOO_LARGE', 'course.json is larger than the limit.', ARCHIVE_PACKAGE_PATH);
  if (!manifestBytes || !packageBytes) return finish();

  // 3. Manifest: format and version first, then structure.
  const parsedManifest = parseJson(manifestBytes);
  if (!parsedManifest.ok) {
    issues.error('MANIFEST_INVALID', 'The archive manifest is not valid JSON.', ARCHIVE_MANIFEST_PATH);
    return finish();
  }
  const rawManifest = parsedManifest.value as Record<string, unknown> | null;
  report.manifest.format = typeof rawManifest?.format === 'string' ? rawManifest.format.slice(0, 100) : null;
  report.manifest.formatVersion = Number.isSafeInteger(rawManifest?.formatVersion) ? (rawManifest!.formatVersion as number) : null;
  if (report.manifest.format !== ARCHIVE_FORMAT) {
    issues.error('FORMAT_UNSUPPORTED', 'This is not an AcademiaPath course archive.', ARCHIVE_MANIFEST_PATH);
    return finish();
  }
  if (report.manifest.formatVersion !== ARCHIVE_FORMAT_VERSION) {
    issues.error('VERSION_UNSUPPORTED', `Archive format version ${String(report.manifest.formatVersion)} is not supported (supported: ${ARCHIVE_FORMAT_VERSION}).`, ARCHIVE_MANIFEST_PATH);
    return finish();
  }
  const manifest = readManifest(rawManifest, issues);
  if (!manifest) return finish();

  // 4. course.json: integrity against the manifest, then the package's own validation (AP-038B).
  if (packageBytes.length !== manifest.package.byteSize || sha256(packageBytes) !== manifest.package.sha256) {
    issues.error('PACKAGE_INTEGRITY', 'course.json does not match the size and SHA-256 recorded in the manifest.', ARCHIVE_PACKAGE_PATH);
    return finish();
  }
  const parsedPackage = parseJson(packageBytes);
  if (!parsedPackage.ok) {
    issues.error('PACKAGE_INVALID', 'course.json is not valid JSON.', ARCHIVE_PACKAGE_PATH);
    return finish();
  }
  const { preview } = analyzePackage(parsedPackage.value);
  if (!preview.valid || !preview.hashVerified) {
    for (const error of preview.errors.slice(0, 20)) issues.error('PACKAGE_INVALID', error.message, `${ARCHIVE_PACKAGE_PATH}: ${error.path}`);
    if (!preview.errors.length) issues.error('PACKAGE_INVALID', 'course.json is not a valid course package.', ARCHIVE_PACKAGE_PATH);
    return finish();
  }
  if (preview.contentHash !== manifest.package.contentHash || preview.formatVersion !== manifest.package.formatVersion) {
    issues.error('PACKAGE_MISMATCH', 'The manifest describes a different course package (content hash or version).', ARCHIVE_PACKAGE_PATH);
  }
  // The package's document references and the manifest's assets must describe exactly the same files.
  const packageAssets = new Map(preview.documents.map((document) => [document.assetKey, document]));
  for (const asset of manifest.assets) {
    const described = packageAssets.get(asset.key);
    if (!described) issues.error('ASSET_UNKNOWN', 'The manifest lists an asset the course package does not describe.', asset.path);
    else if (described.format !== asset.format || described.byteSize !== asset.byteSize || described.sha256 !== asset.sha256) {
      issues.error('ASSET_MISMATCH', 'The manifest and the course package disagree about this asset.', asset.path);
    }
  }
  const declared = new Set(manifest.assets.map((asset) => asset.key));
  for (const key of packageAssets.keys()) if (!declared.has(key)) issues.error('ASSET_NOT_DECLARED', 'The course package describes a document the archive does not include.', key);

  // 5. Asset files: each declared one present with the recorded bytes; nothing undeclared.
  const declaredPaths = new Set(manifest.assets.map((asset) => asset.path));
  for (const path of scan.files.keys()) {
    if (ASSET_PATH.test(path) && !declaredPaths.has(path)) issues.error('UNDECLARED_ASSET', 'The archive holds a file the manifest does not list.', path);
  }
  for (const asset of manifest.assets) {
    const file = scan.kept.get(asset.path);
    if (!scan.files.has(asset.path)) issues.error('ASSET_MISSING', 'A file listed in the manifest is not in the archive.', asset.path);
    else if (!file || file.length !== asset.byteSize || sha256(file) !== asset.sha256) issues.error('ASSET_INTEGRITY', 'A file does not match the size and SHA-256 recorded in the manifest.', asset.path);
    else if (!file.subarray(0, SIGNATURES[asset.format]!.length).equals(SIGNATURES[asset.format]!)) issues.error('ASSET_TYPE_MISMATCH', `A file is not a ${asset.format.toUpperCase()} document.`, asset.path);
  }
  if (issues.failed) return finish();

  // Preview of a new draft course. Documents are bundled here, so the JSON import's "not bundled" skips do not apply.
  for (const warning of preview.packageWarnings) if (warning.code !== 'ASSET_NOT_BUNDLED') issues.warn(`PACKAGE_${warning.code}`, 'The exported course reported this when it was packaged.', warning.target);
  const skipped = preview.skipped.filter((item) => item.reason !== 'DOCUMENT_NOT_BUNDLED');
  const nowImportable = preview.skipped.length - skipped.length;
  for (const item of skipped) issues.warn('ACTIVITY_NOT_IMPORTABLE', 'This activity type cannot be imported yet; only its title would be kept.', item.key);
  report.preview = {
    title: preview.source.title,
    description: preview.source.description,
    sourceCourseCode: preview.source.courseCode,
    exportedAt: preview.source.exportedAt,
    counts: { ...preview.counts, importableActivities: preview.counts.importableActivities + nowImportable, skippedActivities: preview.counts.skippedActivities - nowImportable },
    documents: manifest.assets.map((asset) => {
      const described = packageAssets.get(asset.key)!;
      return { key: asset.key, fileName: described.fileName, format: asset.format, byteSize: asset.byteSize, sha256: asset.sha256, activityKeys: described.activityKeys };
    }),
    documentBytes: manifest.totals.assetBytes,
    skipped,
    requiresDueDate: preview.requiresDueDate,
    packageWarnings: preview.packageWarnings.filter((warning) => warning.code !== 'ASSET_NOT_BUNDLED'),
  };
  return finish();
}
