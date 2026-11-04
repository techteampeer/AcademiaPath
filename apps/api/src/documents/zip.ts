import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { DocumentRejection, EXTRACTION_LIMITS } from './formats.js';

/** Read access to selected parts of a ZIP container, bounded by EXTRACTION_LIMITS. Nothing is written to disk. */
export type ZipArchive = {
  names: ReadonlySet<string>;
  /** Decompressed bytes of one part, or null when the part does not exist. */
  read(name: string): Promise<Buffer | null>;
};

const malformed = () => new DocumentRejection('DOCUMENT_MALFORMED', 'The file is not a valid Office document (the ZIP container could not be read).');
const tooLarge = () =>
  new DocumentRejection('DOCUMENT_LIMITS_EXCEEDED', 'The document expands to more data than the processing limits allow.');

function open(bytes: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    // validateEntrySizes: the stream fails if a part's real size differs from its declared size, so
    // the declared sizes checked below are trustworthy (defense against ZIP bombs with forged headers).
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) reject(malformed());
      else resolve(zip);
    });
  });
}

function listEntries(zip: ZipFile): Promise<Map<string, Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Entry>();
    zip.on('entry', (entry: Entry) => {
      if (entry.isEncrypted()) {
        reject(new DocumentRejection('DOCUMENT_ENCRYPTED', 'Encrypted or password-protected documents are not supported.'));
        zip.close();
        return;
      }
      entries.set(entry.fileName, entry);
      zip.readEntry();
    });
    zip.once('end', () => resolve(entries));
    // Invalid structures and unsafe part names (absolute paths, "..") are rejected by yauzl.
    zip.once('error', () => reject(malformed()));
    zip.readEntry();
  });
}

function readEntry(zip: ZipFile, entry: Entry, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(malformed());
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          stream.destroy();
          reject(tooLarge());
          return;
        }
        chunks.push(chunk);
      });
      stream.once('end', () => resolve(Buffer.concat(chunks, size)));
      stream.once('error', (streamError: Error) => reject(streamError instanceof DocumentRejection ? streamError : malformed()));
    });
  });
}

export async function openZip(bytes: Buffer): Promise<ZipArchive> {
  const zip = await open(bytes);
  if (zip.entryCount > EXTRACTION_LIMITS.maxArchiveEntries) {
    zip.close();
    throw new DocumentRejection('DOCUMENT_LIMITS_EXCEEDED', 'The document contains too many internal parts to process.');
  }
  const entries = await listEntries(zip);
  let budget: number = EXTRACTION_LIMITS.maxArchiveReadBytes;
  return {
    names: new Set(entries.keys()),
    async read(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      if (entry.uncompressedSize > EXTRACTION_LIMITS.maxEntryBytes || entry.uncompressedSize > budget) throw tooLarge();
      budget -= entry.uncompressedSize;
      return readEntry(zip, entry, entry.uncompressedSize);
    },
  };
}
