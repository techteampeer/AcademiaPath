import yauzl, { type Entry } from 'yauzl';

/** Every entry of a ZIP archive in archive order, with its decompressed bytes (sizes validated by yauzl). */
export function zipEntries(archive: Buffer): Promise<Array<{ name: string; data: Buffer }>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const out: Array<{ name: string; data: Buffer }> = [];
      zip.on('error', reject);
      zip.on('end', () => resolve(out));
      zip.on('entry', (entry: Entry) =>
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError);
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            out.push({ name: entry.fileName, data: Buffer.concat(chunks) });
            zip.readEntry();
          });
        }),
      );
      zip.readEntry();
    });
  });
}
