import type { MultipartFile } from '@fastify/multipart';

/**
 * AP-SEC-02: reads one uploaded file part completely, or fails with `tooLarge()` when the client sent more than the
 * route's configured `fileSize` limit. Every multipart route reads its file through this function.
 *
 * Why not `part.toBuffer()` alone: @fastify/multipart (10.1.6) checks the limit only while chunks arrive. Over real
 * HTTP, when the file data received so far ends exactly at the limit and is read before the rest arrives, busboy marks
 * the file truncated without delivering more data and `toBuffer()` returns the first `limit` bytes without an error.
 * (app.inject delivers a body at once, so in-process tests never see this.) The file would then be inspected, or
 * stored as a document, as if it were complete. busboy's `truncated` flag is final once the stream has ended, so it is
 * checked again after the read.
 */
export async function readUploadedFile(part: MultipartFile, tooLarge: () => Error | Promise<Error>): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await part.toBuffer();
  } catch (error) {
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw await tooLarge();
    throw error;
  }
  if (part.file.truncated) throw await tooLarge();
  return bytes;
}
