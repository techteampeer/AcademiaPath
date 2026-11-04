import { posix } from 'node:path';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import type { DocumentFormat, DocumentSegment } from '../db/schema/index.js';
import { DocumentRejection, EXTRACTION_LIMITS, FORMAT_NAMES, normalizeText } from './formats.js';
import type { ZipArchive } from './zip.js';

/**
 * DOCX and PPTX text extraction. Only the XML parts that carry text are parsed (streaming, no DOM).
 * Nothing is executed or fetched: macros, embedded objects, images and external relationship targets
 * are never opened, and XML with DOCTYPE/entity declarations is refused.
 */

const NS = {
  wordprocessing: ['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'],
  drawing: ['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'],
  presentation: ['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main'],
  relationships: ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'],
  markupCompatibility: ['http://schemas.openxmlformats.org/markup-compatibility/2006'],
} as const;

const MAIN_CONTENT_TYPES: Record<string, DocumentFormat | 'macro' | 'other'> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml': 'pptx',
  'application/vnd.ms-word.document.macroEnabled.main+xml': 'macro',
  'application/vnd.ms-word.template.macroEnabledTemplate.main+xml': 'macro',
  'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml': 'macro',
  'application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml': 'macro',
  'application/vnd.ms-powerpoint.template.macroEnabled.main+xml': 'macro',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml': 'other',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml': 'other',
  'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml': 'other',
};

const malformed = (detail = 'The document structure could not be read.') => new DocumentRejection('DOCUMENT_MALFORMED', detail);

const inNamespace = (tag: SaxesTagNS, namespaces: readonly string[], local: string) => tag.local === local && namespaces.includes(tag.uri);

/** Streams one XML part through saxes. DOCTYPE declarations (and therefore custom entities) are rejected. */
function parseXml(xml: Buffer, handlers: { open?: (tag: SaxesTagNS) => void; close?: (tag: SaxesTagNS) => void; text?: (text: string) => void }) {
  const parser = new SaxesParser({ xmlns: true, position: false });
  let failure: Error | null = null;
  parser.on('error', (error) => {
    failure ??= error;
  });
  parser.on('doctype', () => {
    failure ??= malformed('Documents with XML document type declarations are not accepted.');
  });
  if (handlers.open) parser.on('opentag', handlers.open);
  if (handlers.close) parser.on('closetag', handlers.close);
  if (handlers.text) parser.on('text', handlers.text);
  try {
    parser.write(xml.toString('utf8')).close();
  } catch (error) {
    failure ??= error as Error;
  }
  if (failure) throw failure instanceof DocumentRejection ? failure : malformed();
}

const attribute = (tag: SaxesTagNS, local: string, namespaces?: readonly string[]) =>
  Object.values(tag.attributes).find((attr) => attr.local === local && (namespaces ? namespaces.includes(attr.uri) : attr.uri === ''))?.value;

/** Decides DOCX vs PPTX from the package's declared main part (never from the file name). */
export async function identifyPackage(zip: ZipArchive): Promise<{ format: DocumentFormat; mainPart: string }> {
  const contentTypes = await zip.read('[Content_Types].xml');
  if (!contentTypes) throw malformed('The ZIP file is not an Office Open XML document.');
  let found: { kind: DocumentFormat | 'macro' | 'other'; part: string } | null = null;
  parseXml(contentTypes, {
    open(tag) {
      if (tag.local !== 'Override' || found) return;
      const kind = MAIN_CONTENT_TYPES[attribute(tag, 'ContentType') ?? ''];
      const part = attribute(tag, 'PartName');
      if (kind && part) found = { kind, part: part.replace(/^\//, '') };
    },
  });
  const main = found as { kind: DocumentFormat | 'macro' | 'other'; part: string } | null;
  if (!main) throw malformed('The ZIP file is not a Word (.docx) or PowerPoint (.pptx) document.');
  if (main.kind === 'macro') {
    throw new DocumentRejection('UNSUPPORTED_FILE_TYPE', 'Macro-enabled documents (.docm, .pptm) are not accepted. Save the file as .docx or .pptx.');
  }
  if (main.kind === 'other') {
    throw new DocumentRejection('UNSUPPORTED_FILE_TYPE', 'Templates and slide shows are not accepted. Save the file as a .docx document or .pptx presentation.');
  }
  if (!zip.names.has(main.part)) throw malformed();
  return { format: main.kind, mainPart: main.part };
}

type Collector = { segments: DocumentSegment[]; characters: number; truncated: boolean };

function addSegment(collector: Collector, kind: DocumentSegment['kind'], label: string, raw: string) {
  if (collector.truncated) return;
  const text = normalizeText(raw);
  if (!text) return;
  const room = EXTRACTION_LIMITS.maxCharacters - collector.characters;
  if (room <= 0 || collector.segments.length >= EXTRACTION_LIMITS.maxSegments) {
    collector.truncated = true;
    return;
  }
  const kept = text.length > room ? text.slice(0, room) : text;
  if (kept.length < text.length) collector.truncated = true;
  collector.segments.push({ index: collector.segments.length, kind, label, text: kept });
  collector.characters += kept.length;
}

/**
 * Paragraph text of a WordprocessingML part: w:t runs, tabs and breaks. Deleted text (w:delText),
 * field instructions and the fallback copy inside markup-compatibility blocks are skipped.
 */
function wordParagraphs(xml: Buffer, onParagraph: (text: string) => void) {
  const stack: string[] = [];
  let inText = 0;
  let skip = 0;
  parseXml(xml, {
    open(tag) {
      if (inNamespace(tag, NS.markupCompatibility, 'Fallback')) skip += 1;
      if (skip) return;
      if (inNamespace(tag, NS.wordprocessing, 'p')) stack.push('');
      else if (inNamespace(tag, NS.wordprocessing, 't')) inText += 1;
      else if (stack.length && (inNamespace(tag, NS.wordprocessing, 'tab') || inNamespace(tag, NS.wordprocessing, 'ptab'))) stack[stack.length - 1] += '\t';
      else if (stack.length && (inNamespace(tag, NS.wordprocessing, 'br') || inNamespace(tag, NS.wordprocessing, 'cr'))) stack[stack.length - 1] += '\n';
    },
    close(tag) {
      if (inNamespace(tag, NS.markupCompatibility, 'Fallback')) {
        skip -= 1;
        return;
      }
      if (skip) return;
      if (inNamespace(tag, NS.wordprocessing, 't')) inText -= 1;
      else if (inNamespace(tag, NS.wordprocessing, 'p')) onParagraph(stack.pop() ?? '');
    },
    text(value) {
      if (!skip && inText > 0 && stack.length) stack[stack.length - 1] += value;
    },
  });
}

/** Text of one slide: a:t runs grouped into a:p paragraphs (one line each). */
function slideText(xml: Buffer): string {
  const lines: string[] = [];
  let current: string | null = null;
  let inText = 0;
  let skip = 0;
  parseXml(xml, {
    open(tag) {
      if (inNamespace(tag, NS.markupCompatibility, 'Fallback')) skip += 1;
      if (skip) return;
      if (inNamespace(tag, NS.drawing, 'p')) current = '';
      else if (inNamespace(tag, NS.drawing, 't')) inText += 1;
      else if (current !== null && inNamespace(tag, NS.drawing, 'br')) current += '\n';
    },
    close(tag) {
      if (inNamespace(tag, NS.markupCompatibility, 'Fallback')) {
        skip -= 1;
        return;
      }
      if (skip) return;
      if (inNamespace(tag, NS.drawing, 't')) inText -= 1;
      else if (inNamespace(tag, NS.drawing, 'p') && current !== null) {
        lines.push(current);
        current = null;
      }
    },
    text(value) {
      if (!skip && inText > 0 && current !== null) current += value;
    },
  });
  return lines.join('\n');
}

const relsPathFor = (part: string) => posix.join(posix.dirname(part), '_rels', `${posix.basename(part)}.rels`);

/** Internal relationship targets of a part, resolved inside the package. External targets are ignored (never fetched). */
async function internalRelationships(zip: ZipArchive, part: string): Promise<Map<string, string>> {
  const xml = await zip.read(relsPathFor(part));
  const targets = new Map<string, string>();
  if (!xml) return targets;
  parseXml(xml, {
    open(tag) {
      if (tag.local !== 'Relationship') return;
      const id = attribute(tag, 'Id');
      const target = attribute(tag, 'Target');
      if (!id || !target || attribute(tag, 'TargetMode') === 'External') return;
      const resolved = target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(posix.dirname(part), target));
      if (!resolved.startsWith('../') && resolved !== '..') targets.set(id, resolved);
    },
  });
  return targets;
}

/** Slide parts in presentation order (p:sldIdLst), resolved through the presentation's relationships. */
async function slideParts(zip: ZipArchive, presentationPart: string): Promise<string[]> {
  const xml = await zip.read(presentationPart);
  if (!xml) throw malformed();
  const ids: string[] = [];
  parseXml(xml, {
    open(tag) {
      if (!inNamespace(tag, NS.presentation, 'sldId')) return;
      const id = attribute(tag, 'id', NS.relationships);
      if (id) ids.push(id);
    },
  });
  const relationships = await internalRelationships(zip, presentationPart);
  return ids.map((id) => relationships.get(id)).filter((part): part is string => part !== undefined && zip.names.has(part));
}

export type ExtractedText = { segments: DocumentSegment[]; characterCount: number; truncated: boolean; detail: string | null };

export async function extractOfficeText(zip: ZipArchive, format: DocumentFormat, mainPart: string): Promise<ExtractedText> {
  const collector: Collector = { segments: [], characters: 0, truncated: false };
  let detail: string | null = null;
  if (format === 'docx') {
    const xml = await zip.read(mainPart);
    if (!xml) throw malformed();
    let paragraph = 0;
    wordParagraphs(xml, (text) => {
      if (!normalizeText(text)) return;
      paragraph += 1;
      addSegment(collector, 'paragraph', `Paragraph ${paragraph}`, text);
    });
  } else if (format === 'pptx') {
    const slides = await slideParts(zip, mainPart);
    if (slides.length > EXTRACTION_LIMITS.maxSlides) {
      collector.truncated = true;
      detail = `Only the first ${EXTRACTION_LIMITS.maxSlides} slides were processed.`;
    }
    for (const [index, part] of slides.slice(0, EXTRACTION_LIMITS.maxSlides).entries()) {
      const xml = await zip.read(part);
      if (xml) addSegment(collector, 'slide', `Slide ${index + 1}`, slideText(xml));
    }
    if (!detail && slides.length) detail = 'Slide text only (speaker notes, charts and images are not extracted).';
  } else {
    throw malformed(`${FORMAT_NAMES[format]} is not an Office Open XML format.`);
  }
  return { segments: collector.segments, characterCount: collector.characters, truncated: collector.truncated, detail };
}
