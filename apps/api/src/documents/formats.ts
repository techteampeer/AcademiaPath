import type { DocumentFormat } from '../db/schema/index.js';

/**
 * Hard limits for validating and extracting one uploaded document. The upload size limit itself is
 * configurable (`DOCUMENT_MAX_UPLOAD_MB`); these bound the work done on an accepted upload.
 */
export const EXTRACTION_LIMITS = {
  /** Extracted text stored per document; longer documents are truncated (and flagged). */
  maxCharacters: 400_000,
  maxSegments: 5_000,
  maxPdfPages: 500,
  maxSlides: 1_000,
  /** ZIP containers (DOCX/PPTX). */
  maxArchiveEntries: 5_000,
  /** Largest single decompressed XML part that is read. */
  maxEntryBytes: 25 * 1024 * 1024,
  /** Total decompressed bytes read from one archive. */
  maxArchiveReadBytes: 60 * 1024 * 1024,
  /** Heap of the extraction worker; exceeding it terminates the worker. */
  workerHeapMb: 512,
} as const;

export const DOCUMENT_FORMATS: readonly DocumentFormat[] = ['pdf', 'docx', 'pptx'];

/** Media types used when serving the stored original (decided by the server, never by the client). */
export const DOCUMENT_MEDIA_TYPES: Record<DocumentFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export type RejectionCode =
  | 'UNSUPPORTED_FILE_TYPE'
  | 'FILE_SIGNATURE_MISMATCH'
  | 'DOCUMENT_ENCRYPTED'
  | 'DOCUMENT_MALFORMED'
  | 'DOCUMENT_LIMITS_EXCEEDED'
  | 'MALWARE_DETECTED';

export const REJECTION_STATUS: Record<RejectionCode, number> = {
  UNSUPPORTED_FILE_TYPE: 415,
  FILE_SIGNATURE_MISMATCH: 422,
  DOCUMENT_ENCRYPTED: 422,
  DOCUMENT_MALFORMED: 422,
  DOCUMENT_LIMITS_EXCEEDED: 422,
  MALWARE_DETECTED: 422,
};

/** A file that is refused, with a client-safe explanation. */
export class DocumentRejection extends Error {
  constructor(
    readonly code: RejectionCode,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentRejection';
  }
}

export const FORMAT_NAMES: Record<DocumentFormat, string> = { pdf: 'PDF', docx: 'Word (.docx)', pptx: 'PowerPoint (.pptx)' };

/** Format implied by the file name's extension (only an allowlist is accepted). */
export function formatFromFileName(fileName: string): DocumentFormat | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName);
  const extension = match?.[1]?.toLowerCase();
  return extension === 'pdf' || extension === 'docx' || extension === 'pptx' ? extension : null;
}

/**
 * Display name derived from the client-supplied file name: last path component only, no control
 * characters, bounded length. It is never used to build a storage path.
 */
export function sanitizeFileName(raw: string): string {
  const base = raw.replaceAll('\\', '/').split('/').pop() ?? '';
  const cleaned = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'document';
  if (cleaned.length <= 200) return cleaned;
  const extension = /\.[A-Za-z0-9]{1,8}$/.exec(cleaned)?.[0] ?? '';
  return `${cleaned.slice(0, 200 - extension.length).trim()}${extension}`;
}

export type Container = 'pdf' | 'zip' | 'cfb' | 'unknown';

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
/** OLE Compound File: legacy .doc/.ppt, and password-protected (encrypted) Office documents. */
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const startsWith = (bytes: Uint8Array, signature: number[]) => signature.every((value, index) => bytes[index] === value);

/** Identifies the container from the leading bytes, ignoring the extension and the browser's media type. */
export function sniffContainer(bytes: Uint8Array): Container {
  if (startsWith(bytes, ZIP_SIGNATURE)) return 'zip';
  if (startsWith(bytes, CFB_SIGNATURE)) return 'cfb';
  // PDF readers accept the header within the first 1024 bytes.
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  if (head.includes('%PDF-')) return 'pdf';
  return 'unknown';
}

/** Text normalization shared by all parsers: NFC, no control characters (PostgreSQL rejects NUL), tidy whitespace. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f￾￿]/g, '')
    .replace(/[\t  ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
