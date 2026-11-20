/**
 * AP-SEC-02: real-HTTP multipart uploads for the upload-integrity tests. Unlike app.inject, which hands Fastify the
 * whole body at once, these requests reach a listening server in pieces, can pause at an exact byte (for example the
 * configured file-size limit) and can be cut off mid-body, as a slow or failing client would.
 */
import { request as httpRequest } from 'node:http';
import { makePdf } from './documents.js';
import { buildZip, type ZipSpec } from './scorm.js';
import { zipEntries } from './zip.js';

/** A valid PDF of exactly `size` bytes: the padding is a comment line in the header, so the xref offsets stay right. */
export function exactPdf(size: number, text = 'Upload integrity fixture'): Buffer {
  const build = (padding: number) => makePdf([[text, 'Synthetic page.']], { header: `%PDF-1.4\n%${'0'.repeat(padding)}` });
  let padding = Math.max(0, size - build(0).length);
  // The startxref offset can gain a digit as the padding grows; two corrections always reach the exact size.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pdf = build(padding);
    if (pdf.length === size) return pdf;
    padding += size - pdf.length;
  }
  throw new Error(`could not build a PDF of exactly ${size} bytes`);
}

/** The same ZIP's entries plus one stored filler file, so that the archive is exactly `size` bytes and still valid. */
export async function exactZip(zip: Buffer, size: number, fillerName = 'zz-padding.bin'): Promise<Buffer> {
  const entries: ZipSpec[] = (await zipEntries(zip)).map((entry) => ({ name: entry.name, data: entry.data }));
  const build = (filler: number) => buildZip([...entries, { name: fillerName, data: Buffer.alloc(filler, 0x20), method: 'store' }]);
  const overhead = build(0).length;
  const result = build(size - overhead);
  if (result.length !== size) throw new Error(`could not build a ZIP of exactly ${size} bytes`);
  return result;
}

export type RawUpload = {
  port: number;
  path: string;
  /** Cookie header, CSRF token and Origin of a signed-in session. */
  headers: Record<string, string>;
  fileName: string;
  contentType: string;
  file: Buffer;
  /** Send the first `at` bytes of the file, wait `pauseMs`, then the rest (the delayed-chunk case). */
  pause?: { at: number; ms: number };
  /** Send the first `at` bytes of the file, then destroy the connection without finishing the body. */
  abortAt?: number;
};
export type RawResult = { status: number; body: Record<string, unknown> } | { aborted: true };

const BOUNDARY = 'ap-upload-integrity-boundary';

/** One multipart/form-data upload with a single `file` part, sent over a real socket. */
export function rawUpload(options: RawUpload): Promise<RawResult> {
  const head = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${options.fileName}"\r\nContent-Type: ${options.contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: options.port,
        method: 'POST',
        path: options.path,
        headers: { ...options.headers, 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, 'content-length': head.length + options.file.length + tail.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(text) as Record<string, unknown>;
          } catch {
            body = { raw: text.slice(0, 200) };
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (options.abortAt !== undefined) resolve({ aborted: true });
      // The server may answer (413) and close before it has read the whole body.
      else if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') reject(error);
    });
    if (options.abortAt !== undefined) {
      req.write(Buffer.concat([head, options.file.subarray(0, options.abortAt)]), () => setTimeout(() => (req.destroy(), resolve({ aborted: true })), 200));
      return;
    }
    if (options.pause) {
      req.write(Buffer.concat([head, options.file.subarray(0, options.pause.at)]));
      setTimeout(() => req.end(Buffer.concat([options.file.subarray(options.pause!.at), tail])), options.pause.ms);
      return;
    }
    req.end(Buffer.concat([head, options.file, tail]));
  });
}
