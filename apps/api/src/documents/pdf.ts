import type { DocumentSegment } from '../db/schema/index.js';
import { DocumentRejection, EXTRACTION_LIMITS, normalizeText } from './formats.js';
import type { ExtractedText } from './ooxml.js';

/** `/Encrypt` in the trailer marks an encrypted PDF (including owner-password-only files). */
const ENCRYPT_MARKER = /\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/;

type TextItem = { str?: string; hasEOL?: boolean };

/**
 * Selectable text per page with pdf.js (Mozilla). Rendering, scripts and network access are off: pdf.js
 * 6 contains no eval-based code paths, fonts and WebAssembly decoders are not loaded, XFA forms are
 * ignored and no URLs are configured, so links inside the PDF are never fetched. Scanned or image-only pages have no text and are reported as such.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<ExtractedText> {
  if (ENCRYPT_MARKER.test(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1'))) {
    throw new DocumentRejection('DOCUMENT_ENCRYPTED', 'Encrypted or password-protected PDFs are not supported. Remove the protection and upload again.');
  }
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    // pdf.js accepts a plain Uint8Array only (not a Node Buffer); it gets its own copy.
    data: new Uint8Array(bytes),
    useWasm: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    useWorkerFetch: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    stopAtErrors: false,
    verbosity: 0,
  });
  let document: Awaited<typeof task.promise>;
  try {
    document = await task.promise;
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'PasswordException') {
      throw new DocumentRejection('DOCUMENT_ENCRYPTED', 'Encrypted or password-protected PDFs are not supported. Remove the protection and upload again.');
    }
    throw new DocumentRejection('DOCUMENT_MALFORMED', 'The PDF could not be read. It may be damaged or not a real PDF file.');
  }
  try {
    const segments: DocumentSegment[] = [];
    let characters = 0;
    let truncated = document.numPages > EXTRACTION_LIMITS.maxPdfPages;
    const pages = Math.min(document.numPages, EXTRACTION_LIMITS.maxPdfPages);
    for (let number = 1; number <= pages && !(characters >= EXTRACTION_LIMITS.maxCharacters); number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      let raw = '';
      for (const item of content.items as TextItem[]) {
        if (typeof item.str !== 'string') continue;
        raw += item.str;
        if (item.hasEOL) raw += '\n';
      }
      page.cleanup();
      const text = normalizeText(raw);
      if (!text) continue;
      const room = EXTRACTION_LIMITS.maxCharacters - characters;
      const kept = text.length > room ? text.slice(0, room) : text;
      if (kept.length < text.length) truncated = true;
      segments.push({ index: segments.length, kind: 'page', label: `Page ${number}`, text: kept });
      characters += kept.length;
      if (number < pages && characters >= EXTRACTION_LIMITS.maxCharacters) truncated = true;
    }
    const pagesWithText = segments.length;
    const detail =
      pagesWithText === 0
        ? null
        : pagesWithText < document.numPages
          ? `${pagesWithText} of ${document.numPages} pages contain selectable text; the others may be scanned images (OCR is not available).`
          : null;
    return { segments, characterCount: characters, truncated, detail };
  } finally {
    await task.destroy();
  }
}
