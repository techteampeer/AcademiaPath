import { crc32 } from 'node:zlib';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { SCORM_LIMITS } from './limits.js';
import { checkEntryName, collisionKey } from './paths.js';

/**
 * AP-033B: structural and safety inspection of an untrusted ZIP archive, entirely in memory. Entry names are decoded
 * and checked by this module (never by an extractor), every entry is decompressed only to count its bytes and verify
 * its CRC-32, and only imsmanifest.xml (plus any small file the caller asks to keep) is kept. Nothing is written to disk.
 * Shared by the SCORM (AP-033B) and Common Cartridge (AP-038D) inspectors, which report its problems under their own
 * issue codes.
 */
export type ArchiveProblem =
  | 'ARCHIVE_INVALID'
  | 'ARCHIVE_TOO_MANY_ENTRIES'
  | 'ARCHIVE_TOO_LARGE'
  | 'PATH_TRAVERSAL'
  | 'PATH_ABSOLUTE'
  | 'PATH_INVALID'
  | 'PATH_DUPLICATE'
  | 'PATH_COLLISION'
  | 'ENTRY_ENCRYPTED'
  | 'ENTRY_SYMLINK'
  | 'ENTRY_SPECIAL_FILE'
  | 'ENTRY_COMPRESSION_UNSUPPORTED'
  | 'ENTRY_TOO_LARGE'
  | 'ENTRY_EXPANSION_RATIO'
  | 'ENTRY_CORRUPT';
export const ARCHIVE_PROBLEMS: readonly ArchiveProblem[] = [
  'ARCHIVE_INVALID',
  'ARCHIVE_TOO_MANY_ENTRIES',
  'ARCHIVE_TOO_LARGE',
  'PATH_TRAVERSAL',
  'PATH_ABSOLUTE',
  'PATH_INVALID',
  'PATH_DUPLICATE',
  'PATH_COLLISION',
  'ENTRY_ENCRYPTED',
  'ENTRY_SYMLINK',
  'ENTRY_SPECIAL_FILE',
  'ENTRY_COMPRESSION_UNSUPPORTED',
  'ENTRY_TOO_LARGE',
  'ENTRY_EXPANSION_RATIO',
  'ENTRY_CORRUPT',
];
/** Receives archive problems; each package format maps them to its own issue codes. */
export type ArchiveIssueSink = { error(problem: ArchiveProblem, details?: { path?: string | null; limit?: number | null; value?: string | null }): void };
/** Small files a caller wants to read after verification (e.g. resource descriptors); bounded by the caller. */
export type ArchiveScanOptions = { keep?: (path: string, size: number) => boolean };

export type ArchiveFile = { path: string; size: number };

export type ArchiveScan = {
  /** False when the archive has a safety or integrity problem: its content must not be inspected further. */
  safe: boolean;
  fileCount: number;
  folderCount: number;
  /** Verified total decompressed size, or the declared total when verification did not run; null if unreadable. */
  uncompressedBytes: number | null;
  /** Files by exact path. */
  files: Map<string, ArchiveFile>;
  /** Exact path by collision key, to explain references that differ only in letter case. */
  byKey: Map<string, string>;
  /** Bytes of the root imsmanifest.xml, when present and within the size limit. */
  manifest: Buffer | null;
  manifestTooLarge: boolean;
  /** Verified bytes of the other files the caller asked to keep. */
  kept: Map<string, Buffer>;
};

export const MANIFEST_PATH = 'imsmanifest.xml';
const ZIP_SIGNATURES = [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x05, 0x06])];

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
/** "Version made by" hosts whose external attributes carry Unix file modes: Unix and macOS. */
const UNIX_HOSTS = new Set([3, 19]);

function open(bytes: Buffer): Promise<ZipFile | null> {
  return new Promise((resolve) => {
    // decodeStrings: false — names are decoded and validated below with specific errors (yauzl would only say "invalid").
    // validateEntrySizes — a stream fails if an entry's real size differs from its declared size (forged headers).
    yauzl.fromBuffer(bytes, { lazyEntries: true, decodeStrings: false, validateEntrySizes: true, strictFileNames: true }, (error, zip) =>
      resolve(error || !zip ? null : zip),
    );
  });
}

function listEntries(zip: ZipFile): Promise<Entry[] | null> {
  return new Promise((resolve) => {
    const entries: Entry[] = [];
    zip.on('entry', (entry: Entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.once('end', () => resolve(entries));
    zip.once('error', () => resolve(null));
    zip.readEntry();
  });
}

/** Decompresses one entry, counting its bytes and CRC-32; returns its bytes only when `keep` is set. */
function verifyEntry(zip: ZipFile, entry: Entry, keep: boolean): Promise<{ ok: true; size: number; bytes: Buffer | null } | { ok: false }> {
  return new Promise((resolve) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        resolve({ ok: false });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let checksum = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        checksum = crc32(chunk, checksum);
        if (size > entry.uncompressedSize) {
          stream.destroy();
          resolve({ ok: false });
          return;
        }
        if (keep) chunks.push(chunk);
      });
      stream.once('end', () => resolve(size === entry.uncompressedSize && checksum >>> 0 === entry.crc32 >>> 0 ? { ok: true, size, bytes: keep ? Buffer.concat(chunks, size) : null } : { ok: false }));
      stream.once('error', () => resolve({ ok: false }));
    });
  });
}

const emptyScan = (): ArchiveScan => ({
  safe: false,
  fileCount: 0,
  folderCount: 0,
  uncompressedBytes: null,
  files: new Map(),
  byKey: new Map(),
  manifest: null,
  manifestTooLarge: false,
  kept: new Map(),
});

export async function scanArchive(bytes: Buffer, issues: ArchiveIssueSink, options: ArchiveScanOptions = {}): Promise<ArchiveScan> {
  const scan = emptyScan();
  if (!ZIP_SIGNATURES.some((signature) => bytes.subarray(0, 4).equals(signature))) {
    issues.error('ARCHIVE_INVALID');
    return scan;
  }
  const zip = await open(bytes);
  if (!zip) {
    issues.error('ARCHIVE_INVALID');
    return scan;
  }
  try {
    if (zip.entryCount > SCORM_LIMITS.maxEntries) {
      issues.error('ARCHIVE_TOO_MANY_ENTRIES', { limit: SCORM_LIMITS.maxEntries });
      return scan;
    }
    const entries = await listEntries(zip);
    if (!entries) {
      issues.error('ARCHIVE_INVALID');
      return scan;
    }

    let safe = true;
    let declaredTotal = 0;
    let totalReported = false;
    const exact = new Map<string, 'file' | 'folder'>();
    const keys = new Map<string, string>();
    const folders = new Set<string>();
    const fileEntries: Array<{ entry: Entry; path: string }> = [];

    for (const entry of entries) {
      const name = yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, entry.extraFields, true);
      const problem = checkEntryName(name);
      if (problem) {
        safe = false;
        issues.error(problem === 'traversal' ? 'PATH_TRAVERSAL' : problem === 'absolute' ? 'PATH_ABSOLUTE' : 'PATH_INVALID', { path: name });
        continue;
      }
      if (entry.isEncrypted()) {
        safe = false;
        issues.error('ENTRY_ENCRYPTED', { path: name });
        continue;
      }
      const isFolder = name.endsWith('/');
      const host = entry.versionMadeBy >>> 8;
      const fileType = ((entry.externalFileAttributes >>> 16) & 0xffff) & S_IFMT;
      if (UNIX_HOSTS.has(host) && fileType !== 0 && fileType !== S_IFREG && fileType !== S_IFDIR) {
        safe = false;
        issues.error(fileType === S_IFLNK ? 'ENTRY_SYMLINK' : 'ENTRY_SPECIAL_FILE', { path: name });
        continue;
      }

      const path = isFolder ? name.slice(0, -1) : name;
      const key = collisionKey(path);
      const previous = exact.get(path);
      if (previous) {
        // Repeated folder entries are harmless; a repeated file name is ambiguous.
        if (!(previous === 'folder' && isFolder)) {
          safe = false;
          issues.error('PATH_DUPLICATE', { path });
        }
        continue;
      }
      const sameKey = keys.get(key);
      if (sameKey !== undefined && sameKey !== path) {
        safe = false;
        issues.error('PATH_COLLISION', { path, value: sameKey });
        continue;
      }
      exact.set(path, isFolder ? 'folder' : 'file');
      keys.set(key, path);
      const segments = path.split('/');
      for (let depth = 1; depth < segments.length; depth += 1) folders.add(segments.slice(0, depth).join('/'));
      if (isFolder) {
        folders.add(path);
        continue;
      }

      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
        safe = false;
        issues.error('ENTRY_COMPRESSION_UNSUPPORTED', { path, value: String(entry.compressionMethod) });
        continue;
      }
      if (entry.uncompressedSize > SCORM_LIMITS.maxEntryBytes) {
        safe = false;
        issues.error('ENTRY_TOO_LARGE', { path, limit: SCORM_LIMITS.maxEntryBytes });
        continue;
      }
      if (entry.uncompressedSize >= SCORM_LIMITS.ratioCheckFromBytes && entry.uncompressedSize / Math.max(entry.compressedSize, 1) > SCORM_LIMITS.maxExpansionRatio) {
        safe = false;
        issues.error('ENTRY_EXPANSION_RATIO', { path, limit: SCORM_LIMITS.maxExpansionRatio });
        continue;
      }
      declaredTotal += entry.uncompressedSize;
      if (declaredTotal > SCORM_LIMITS.maxTotalBytes && !totalReported) {
        safe = false;
        totalReported = true;
        issues.error('ARCHIVE_TOO_LARGE', { limit: SCORM_LIMITS.maxTotalBytes });
      }
      fileEntries.push({ entry, path });
    }

    // A file may not share its name with a folder another entry implies ("a" and "a/b.html").
    for (const folder of folders) {
      const clash = keys.get(collisionKey(folder));
      if (clash !== undefined && exact.get(clash) === 'file') {
        safe = false;
        issues.error('PATH_COLLISION', { path: clash });
      }
    }

    scan.fileCount = fileEntries.length;
    scan.folderCount = folders.size;
    scan.uncompressedBytes = declaredTotal;
    if (!safe) return scan;

    let verifiedTotal = 0;
    for (const { entry, path } of fileEntries) {
      const isManifest = path === MANIFEST_PATH;
      const tooLargeManifest = isManifest && entry.uncompressedSize > SCORM_LIMITS.maxManifestBytes;
      const keep = !isManifest && options.keep?.(path, entry.uncompressedSize) === true;
      const result = await verifyEntry(zip, entry, (isManifest && !tooLargeManifest) || keep);
      if (!result.ok) {
        issues.error('ENTRY_CORRUPT', { path });
        return scan;
      }
      verifiedTotal += result.size;
      if (verifiedTotal > SCORM_LIMITS.maxTotalBytes) {
        issues.error('ARCHIVE_TOO_LARGE', { limit: SCORM_LIMITS.maxTotalBytes });
        return scan;
      }
      scan.files.set(path, { path, size: result.size });
      scan.byKey.set(collisionKey(path), path);
      if (isManifest) {
        scan.manifest = result.bytes;
        scan.manifestTooLarge = tooLargeManifest;
      } else if (keep && result.bytes) {
        scan.kept.set(path, result.bytes);
      }
    }
    scan.uncompressedBytes = verifiedTotal;
    scan.safe = true;
    return scan;
  } finally {
    zip.close();
  }
}
