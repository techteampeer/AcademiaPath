import yazl from 'yazl';

/**
 * AP-038C1B: builds a ZIP archive in memory from server-controlled entries (for the portable course export). Uses
 * yazl (the companion writer of the yauzl reader the inspectors use); no ZIP structures are written by hand.
 *
 * - Entries come only from buffers, in the given order: no local file is read, so no filesystem path, owner or
 *   timestamp can end up in the archive. No archive or file comments are written.
 * - Metadata is fixed (1980-01-01 00:00 DOS time, mode 0644), so the same entries always give the same bytes.
 * - Names must match a strict ASCII allow-list (no traversal, absolute paths, backslashes or hidden segments), and must
 *   be unique ignoring letter case, so every archive passes the inspectors' scanner (`scanArchive`).
 * - The archive is at most ZIP_MAX_BYTES. Any failure rejects the promise; no partial archive is ever returned.
 * - Entries are stored uncompressed unless `compress` is set (for text such as JSON). Stored entries can never trip the
 *   scanner's expansion-ratio check; compress only data that is not extremely repetitive.
 */
export const ZIP_MAX_BYTES = 25 * 1024 * 1024;
/** The scanner's entry limit; course archives stay far below it. */
export const ZIP_MAX_ENTRIES = 10_000;
const MAX_NAME_BYTES = 255;
const MAX_DEPTH = 8;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const FIXED_TIME = new Date(1980, 0, 1, 0, 0, 0);
const FILE_MODE = 0o100644;

export type ZipEntryInput = { path: string; data: Buffer; compress?: boolean };
export type ZipWriteProblem = 'INVALID_ENTRY_NAME' | 'DUPLICATE_ENTRY' | 'INVALID_ENTRY_DATA' | 'TOO_MANY_ENTRIES' | 'ARCHIVE_TOO_LARGE' | 'ZIP_WRITE_FAILED';

export class ZipWriteError extends Error {
  constructor(
    readonly problem: ZipWriteProblem,
    message: string,
  ) {
    super(message);
    this.name = 'ZipWriteError';
  }
}

/** Whether a name is an allowed archive path: ASCII segments joined by `/`, none starting with a dot. */
export function isSafeEntryName(path: string): boolean {
  if (typeof path !== 'string' || !path.length || Buffer.byteLength(path) > MAX_NAME_BYTES) return false;
  const segments = path.split('/');
  return segments.length <= MAX_DEPTH && segments.every((segment) => SEGMENT.test(segment));
}

function validate(entries: readonly ZipEntryInput[]): void {
  if (entries.length > ZIP_MAX_ENTRIES) throw new ZipWriteError('TOO_MANY_ENTRIES', `An archive holds at most ${ZIP_MAX_ENTRIES} entries.`);
  const seen = new Set<string>();
  let storedBytes = 0;
  for (const entry of entries) {
    if (!isSafeEntryName(entry.path)) throw new ZipWriteError('INVALID_ENTRY_NAME', 'An archive entry name is not allowed.');
    if (!Buffer.isBuffer(entry.data)) throw new ZipWriteError('INVALID_ENTRY_DATA', 'An archive entry has no buffer content.');
    // Case-insensitive, as the scanner (and case-insensitive file systems) treat these names as the same file. A file
    // may also not share its name with a folder another entry needs.
    const key = entry.path.toLowerCase();
    const parents = key.split('/').slice(0, -1).map((_, index, parts) => `${parts.slice(0, index + 1).join('/')}/`);
    if (seen.has(key) || seen.has(`${key}/`) || parents.some((parent) => seen.has(parent.slice(0, -1)))) {
      throw new ZipWriteError('DUPLICATE_ENTRY', 'Two archive entries have the same path.');
    }
    seen.add(key);
    for (const parent of parents) seen.add(parent);
    if (!entry.compress) storedBytes += entry.data.length;
  }
  // Stored entries alone already exceed the limit: refuse before doing any work.
  if (storedBytes > ZIP_MAX_BYTES) throw new ZipWriteError('ARCHIVE_TOO_LARGE', `The archive would exceed ${ZIP_MAX_BYTES / (1024 * 1024)} MB.`);
}

/** Writes the entries, in order, into one ZIP archive of at most ZIP_MAX_BYTES. */
export async function writeZip(entries: readonly ZipEntryInput[]): Promise<Buffer> {
  validate(entries);
  return new Promise<Buffer>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = zip.outputStream as NodeJS.ReadableStream & { destroy(): void };
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: ZipWriteError) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      output.destroy();
      reject(error);
    };
    output.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > ZIP_MAX_BYTES) fail(new ZipWriteError('ARCHIVE_TOO_LARGE', `The archive would exceed ${ZIP_MAX_BYTES / (1024 * 1024)} MB.`));
      else chunks.push(chunk);
    });
    output.on('error', () => fail(new ZipWriteError('ZIP_WRITE_FAILED', 'The archive could not be written.')));
    zip.on('error', () => fail(new ZipWriteError('ZIP_WRITE_FAILED', 'The archive could not be written.')));
    output.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, size));
    });
    try {
      for (const entry of entries) {
        zip.addBuffer(entry.data, entry.path, { mtime: FIXED_TIME, mode: FILE_MODE, forceDosTimestamp: true, compress: entry.compress === true });
      }
      zip.end();
    } catch {
      fail(new ZipWriteError('ZIP_WRITE_FAILED', 'The archive could not be written.'));
    }
  });
}
