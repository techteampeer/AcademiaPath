import type { DocumentExtractionStatus, DocumentFormat, DocumentSegment } from '../db/schema/index.js';
import { DocumentRejection, FORMAT_NAMES, sniffContainer, type RejectionCode } from './formats.js';
import { extractOfficeText, identifyPackage } from './ooxml.js';
import { extractPdfText } from './pdf.js';
import { openZip } from './zip.js';

export type ExtractionSuccess = {
  ok: true;
  format: DocumentFormat;
  status: DocumentExtractionStatus;
  segments: DocumentSegment[];
  characterCount: number;
  truncated: boolean;
  detail: string | null;
};
export type ExtractionFailure = { ok: false; code: RejectionCode; message: string };
export type ExtractionOutcome = ExtractionSuccess | ExtractionFailure;

const NO_TEXT_DETAIL: Record<DocumentFormat, string> = {
  pdf: 'No selectable text was found. The PDF may contain only scanned pages or images; OCR is not available, so no text was extracted.',
  docx: 'The document contains no text paragraphs (images and embedded objects are not extracted).',
  pptx: 'The slides contain no text (images, charts and embedded objects are not extracted).',
};

/**
 * Validates the container against the expected format (taken from the allowlisted extension) and
 * extracts its text. The format is decided from the file's own bytes and structure; the extension
 * and the browser's media type are never trusted on their own.
 */
async function extract(bytes: Uint8Array, expected: DocumentFormat): Promise<ExtractionSuccess> {
  if (bytes.byteLength === 0) throw new DocumentRejection('DOCUMENT_MALFORMED', 'The file is empty.');
  const container = sniffContainer(bytes);
  if (container === 'cfb') {
    throw new DocumentRejection(
      'DOCUMENT_ENCRYPTED',
      'This is a password-protected Office file or a legacy .doc/.ppt file. Save it without a password as .docx or .pptx and upload again.',
    );
  }
  let result: Omit<ExtractionSuccess, 'ok' | 'status'>;
  if (container === 'pdf') {
    if (expected !== 'pdf') throw mismatch('PDF', expected);
    result = { format: 'pdf', ...(await extractPdfText(bytes)) };
  } else if (container === 'zip') {
    if (expected === 'pdf') throw mismatch('ZIP-based Office', expected);
    const zip = await openZip(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const { format, mainPart } = await identifyPackage(zip);
    if (format !== expected) throw mismatch(FORMAT_NAMES[format], expected);
    result = { format, ...(await extractOfficeText(zip, format, mainPart)) };
  } else {
    throw new DocumentRejection('FILE_SIGNATURE_MISMATCH', `The file content is not a valid ${FORMAT_NAMES[expected]} file.`);
  }
  const status: DocumentExtractionStatus = result.segments.length ? 'extracted' : 'no_text';
  return { ok: true, ...result, status, detail: status === 'no_text' ? NO_TEXT_DETAIL[result.format] : result.detail };
}

const mismatch = (actual: string, expected: DocumentFormat) =>
  new DocumentRejection('FILE_SIGNATURE_MISMATCH', `The file content (${actual}) does not match its .${expected} extension.`);

/** Never throws: every failure becomes a client-safe rejection (internal error details are not exposed). */
export async function extractDocument(bytes: Uint8Array, expected: DocumentFormat): Promise<ExtractionOutcome> {
  try {
    return await extract(bytes, expected);
  } catch (error) {
    if (error instanceof DocumentRejection) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'DOCUMENT_MALFORMED', message: `The ${FORMAT_NAMES[expected]} file could not be read.` };
  }
}
