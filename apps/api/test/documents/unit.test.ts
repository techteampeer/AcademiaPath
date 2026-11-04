/**
 * Document validation, extraction, mock summaries and storage, without a database. All documents are
 * synthetic and generated in code (test/helpers/documents.ts).
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { extractDocument } from '../../src/documents/extract.js';
import { extractInWorker } from '../../src/documents/extraction.js';
import { EXTRACTION_LIMITS, formatFromFileName, sanitizeFileName, sniffContainer } from '../../src/documents/formats.js';
import { LocalDocumentStorage } from '../../src/documents/storage.js';
import { mockSummaryProvider } from '../../src/documents/summary.js';
import { DOCM_MAIN, docxEntries, makeDocx, makePdf, makePptx, makeZip } from '../helpers/documents.js';

const SVS = [
  'El sistema de valor del servicio describe cómo los componentes de la organización trabajan juntos para crear valor.',
  'Los principios guía orientan a la organización en todas las circunstancias y decisiones importantes.',
  'La cadena de valor del servicio es un modelo operativo con seis actividades de la cadena de valor.',
  'La mejora continua tiene lugar en todas las áreas de la organización y en todos sus niveles.',
];

const expectRejected = async (bytes: Buffer, format: 'pdf' | 'docx' | 'pptx', code: string) => {
  const outcome = await extractDocument(bytes, format);
  assert.equal(outcome.ok, false, `expected ${code}`);
  if (!outcome.ok) assert.equal(outcome.code, code, outcome.message);
  return outcome;
};

describe('document format detection', () => {
  it('accepts only .pdf, .docx and .pptx names and sanitizes display names', () => {
    assert.equal(formatFromFileName('Guía.PDF'), 'pdf');
    assert.equal(formatFromFileName('notes.docx'), 'docx');
    assert.equal(formatFromFileName('deck.pptx'), 'pptx');
    for (const name of ['report.doc', 'macro.docm', 'deck.pptm', 'page.html', 'archive.zip', 'noextension', 'evil.pdf.exe']) {
      assert.equal(formatFromFileName(name), null, name);
    }
    assert.equal(sanitizeFileName('../../etc/passwd.pdf'), 'passwd.pdf');
    assert.equal(sanitizeFileName('C:\\Users\\me\\Guía final.docx'), 'Guía final.docx');
    assert.equal(sanitizeFileName('a\u0000b\u202e.pdf'), 'ab.pdf');
    assert.equal(sanitizeFileName('..'), 'document');
    assert.ok(sanitizeFileName(`${'x'.repeat(300)}.pdf`).endsWith('.pdf'));
    assert.ok(sanitizeFileName(`${'x'.repeat(300)}.pdf`).length <= 200);
  });

  it('identifies containers from their bytes, not their names', () => {
    assert.equal(sniffContainer(makePdf([['x']])), 'pdf');
    assert.equal(sniffContainer(makeDocx(['x'])), 'zip');
    assert.equal(sniffContainer(Buffer.from('d0cf11e0a1b11ae1', 'hex')), 'cfb');
    assert.equal(sniffContainer(Buffer.from('<html><script>alert(1)</script>')), 'unknown');
  });
});

describe('text extraction (PDF, DOCX, PPTX)', () => {
  it('1. PDF: text per page with page numbers, including accents and compressed streams', async () => {
    for (const compress of [false, true]) {
      const outcome = await extractDocument(makePdf([SVS.slice(0, 2), SVS.slice(2)], { compress }), 'pdf');
      assert.ok(outcome.ok);
      assert.equal(outcome.status, 'extracted');
      assert.deepEqual(outcome.segments.map((s) => [s.kind, s.label]), [['page', 'Page 1'], ['page', 'Page 2']]);
      assert.equal(outcome.segments[0]!.text, SVS.slice(0, 2).join('\n'));
      assert.equal(outcome.segments[1]!.text, SVS.slice(2).join('\n'));
      assert.equal(outcome.characterCount, outcome.segments.reduce((n, s) => n + s.text.length, 0));
    }
  });

  it('2. DOCX: paragraphs in order; tabs, breaks and text boxes; no deleted text or fallback duplicates', async () => {
    const outcome = await extractDocument(makeDocx(SVS), 'docx');
    assert.ok(outcome.ok);
    assert.deepEqual(outcome.segments.map((s) => s.text), SVS);
    assert.deepEqual(outcome.segments.map((s) => s.label), ['Paragraph 1', 'Paragraph 2', 'Paragraph 3', 'Paragraph 4']);

    const body =
      '<w:p><w:r><w:t>Antes</w:t></w:r><w:r><w:tab/><w:t>después</w:t><w:br/><w:t>línea</w:t></w:r></w:p>' +
      '<w:p><w:del><w:r><w:delText>texto borrado</w:delText></w:r></w:del><w:r><w:t>texto vigente</w:t></w:r></w:p>' +
      '<w:p><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps"><w:t>caja</w:t></mc:Choice><mc:Fallback><w:t>caja duplicada</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p>' +
      '<w:p></w:p>';
    const detailed = await extractDocument(makeDocx([], { bodyXml: body }), 'docx');
    assert.ok(detailed.ok);
    assert.deepEqual(detailed.segments.map((s) => s.text), ['Antes después\nlínea', 'texto vigente', 'caja']);
  });

  it('3. PPTX: slide text in presentation order (sldIdLst), external relationships ignored', async () => {
    const slides = [['Incident management', 'Restores normal service operation.'], ['Change enablement'], ['Service desk', 'Single point of contact.']];
    const outcome = await extractDocument(makePptx(slides, { reverseParts: true }), 'pptx');
    assert.ok(outcome.ok);
    assert.deepEqual(outcome.segments.map((s) => s.label), ['Slide 1', 'Slide 2', 'Slide 3']);
    assert.deepEqual(outcome.segments.map((s) => s.text), slides.map((lines) => lines.join('\n')));
  });

  it('reports files without selectable text honestly (no OCR, nothing invented)', async () => {
    const scanned = await extractDocument(makePdf([[], []]), 'pdf');
    assert.ok(scanned.ok);
    assert.equal(scanned.status, 'no_text');
    assert.deepEqual(scanned.segments, []);
    assert.match(scanned.detail ?? '', /OCR is not available/);
    const partial = await extractDocument(makePdf([[SVS[0]!], []]), 'pdf');
    assert.ok(partial.ok);
    assert.equal(partial.status, 'extracted');
    assert.match(partial.detail ?? '', /1 of 2 pages contain selectable text/);
  });
});

describe('document rejections', () => {
  it('6. invalid signatures and extension mismatches', async () => {
    await expectRejected(Buffer.from('<html><body>not a pdf</body></html>'), 'pdf', 'FILE_SIGNATURE_MISMATCH');
    await expectRejected(Buffer.from('MZ\x90\x00 executable'), 'docx', 'FILE_SIGNATURE_MISMATCH');
    await expectRejected(makeDocx(SVS), 'pdf', 'FILE_SIGNATURE_MISMATCH');
    await expectRejected(makePdf([SVS]), 'docx', 'FILE_SIGNATURE_MISMATCH');
    await expectRejected(makeDocx(SVS), 'pptx', 'FILE_SIGNATURE_MISMATCH');
    await expectRejected(makePptx([['x']]), 'docx', 'FILE_SIGNATURE_MISMATCH');
    await expectRejected(Buffer.alloc(0), 'pdf', 'DOCUMENT_MALFORMED');
  });

  it('encrypted and password-protected files', async () => {
    await expectRejected(makePdf([SVS], { encryptMarker: true }), 'pdf', 'DOCUMENT_ENCRYPTED');
    await expectRejected(Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(512)]), 'docx', 'DOCUMENT_ENCRYPTED');
    const encryptedEntry = docxEntries(SVS).map((entry) => (entry.name === 'word/document.xml' ? { ...entry, flags: 1 } : entry));
    await expectRejected(makeZip(encryptedEntry), 'docx', 'DOCUMENT_ENCRYPTED');
  });

  it('malformed, macro-enabled and unsafe documents', async () => {
    await expectRejected(Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('garbage without objects')]), 'pdf', 'DOCUMENT_MALFORMED');
    await expectRejected(Buffer.from('PK\u0003\u0004 truncated archive'), 'docx', 'DOCUMENT_MALFORMED');
    await expectRejected(makeZip([{ name: 'readme.txt', data: 'plain zip' }]), 'docx', 'DOCUMENT_MALFORMED');
    await expectRejected(makeDocx(SVS, { mainType: DOCM_MAIN }), 'docx', 'UNSUPPORTED_FILE_TYPE');
    // XML entity expansion ("billion laughs") and external entities need a DOCTYPE, which is refused.
    const doctype = '<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///etc/passwd">]>';
    await expectRejected(makeDocx([], { prefix: doctype, bodyXml: '<w:p><w:r><w:t>&x;</w:t></w:r></w:p>' }), 'docx', 'DOCUMENT_MALFORMED');
    await expectRejected(makeDocx([], { bodyXml: '<w:p><w:r><w:t>unclosed' }), 'docx', 'DOCUMENT_MALFORMED');
  });

  it('7. archive part names with path traversal are refused (and nothing is ever written to disk)', async () => {
    for (const name of ['../../etc/evil.xml', '/etc/evil.xml', 'word\\..\\..\\evil.xml']) {
      const entries = [...docxEntries(SVS), { name, data: 'x' }];
      await expectRejected(makeZip(entries), 'docx', 'DOCUMENT_MALFORMED');
    }
  });

  it('bounds decompressed size: ZIP bombs and forged size headers', async () => {
    const huge = Buffer.alloc(EXTRACTION_LIMITS.maxEntryBytes + 1024, 0x20);
    const bombEntries = docxEntries(SVS).map((entry) =>
      entry.name === 'word/document.xml' ? { ...entry, data: Buffer.concat([Buffer.from(String(entry.data)), huge]) } : entry,
    );
    const archive = makeZip(bombEntries);
    assert.ok(archive.length < 200_000, 'compressed archive is small');
    await expectRejected(archive, 'docx', 'DOCUMENT_LIMITS_EXCEEDED');
    // The header claims 100 bytes but the part inflates to far more: reading stops at the declared size.
    const forged = docxEntries(SVS).map((entry) => (entry.name === 'word/document.xml' ? { ...entry, declaredSize: 100 } : entry));
    await expectRejected(makeZip(forged), 'docx', 'DOCUMENT_MALFORMED');
    const many = [...docxEntries(SVS), ...Array.from({ length: EXTRACTION_LIMITS.maxArchiveEntries }, (_, i) => ({ name: `media/${i}.bin`, data: 'x', store: true }))];
    await expectRejected(makeZip(many), 'docx', 'DOCUMENT_LIMITS_EXCEEDED');
  });

  it('extracts in a worker thread with a hard time limit', async () => {
    const ok = await extractInWorker(makePdf([SVS]), 'pdf', 20_000);
    assert.ok(ok.ok);
    assert.equal(ok.segments[0]!.text, SVS.join('\n'));
    const slow = await extractInWorker(makePdf(Array.from({ length: 40 }, () => SVS)), 'pdf', 1);
    assert.deepEqual(slow.ok ? null : slow.code, 'DOCUMENT_LIMITS_EXCEEDED');
  });
});

describe('mock summary provider', () => {
  const segments = [
    { index: 0, kind: 'page' as const, label: 'Page 1', text: `${SVS[0]} ${SVS[1]}\n${SVS[2]}` },
    { index: 1, kind: 'page' as const, label: 'Page 2', text: `${SVS[3]}\nLa organización mejora el valor del servicio con mejora continua en la organización.` },
  ];
  const collapse = (value: string) => value.replace(/\s+/g, ' ');

  it('13. uses only extracted sentences, each with its page as evidence; labelled as simulated', async () => {
    assert.equal(mockSummaryProvider.mode, 'mock');
    assert.equal(mockSummaryProvider.label, 'Mock AI summary — local demonstration');
    const result = await mockSummaryProvider.summarize({ segments, revision: 1 });
    assert.equal(result.status, 'ready');
    assert.ok(result.points.length >= 2 && result.points.length <= 5);
    for (const point of result.points) {
      const segment = segments[point.evidence.segmentIndex]!;
      assert.equal(point.evidence.label, segment.label);
      assert.ok(collapse(segment.text).includes(point.evidence.quote), `quote not in source: ${point.evidence.quote}`);
      assert.ok(point.evidence.quote.startsWith(point.text.replace(/…$/, '')), 'point text is the original sentence');
    }
  });

  it('is deterministic per revision and alternates strategies on refresh', async () => {
    const first = await mockSummaryProvider.summarize({ segments, revision: 1 });
    assert.deepEqual(await mockSummaryProvider.summarize({ segments, revision: 1 }), first);
    const second = await mockSummaryProvider.summarize({ segments, revision: 2 });
    assert.equal(first.strategy, 'key_sentences');
    assert.equal(second.strategy, 'section_coverage');
    assert.deepEqual(await mockSummaryProvider.summarize({ segments, revision: 3 }), first);
  });

  it('returns insufficient_text instead of inventing content', async () => {
    assert.deepEqual(await mockSummaryProvider.summarize({ segments: [], revision: 1 }), { status: 'insufficient_text', strategy: 'key_sentences', points: [] });
    const short = [{ index: 0, kind: 'slide' as const, label: 'Slide 1', text: 'Agenda\nQuestions?' }];
    assert.equal((await mockSummaryProvider.summarize({ segments: short, revision: 1 })).status, 'insufficient_text');
  });
});

describe('local document storage', () => {
  let root: string;
  after(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('stores files under opaque server-generated names with owner-only permissions; rejects path tricks', async () => {
    root = await mkdtemp(join(tmpdir(), 'ap-docs-'));
    const storage = new LocalDocumentStorage(join(root, 'store'));
    const key = await storage.put(Buffer.from('%PDF-1.4 test'));
    assert.match(key, /^[0-9a-f-]{36}$/);
    assert.deepEqual(await readdir(join(root, 'store')), [key]);
    assert.equal((await stat(join(root, 'store', key))).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, 'store'))).mode & 0o777, 0o700);
    assert.equal((await storage.read(key)).toString(), '%PDF-1.4 test');
    for (const bad of ['../../etc/passwd', '..', `${key}/../x`, '/etc/passwd', 'not-a-uuid', `${key}.pdf`]) {
      await assert.rejects(storage.read(bad), /Invalid document storage key/, bad);
    }
    await storage.remove(key);
    assert.deepEqual(await readdir(join(root, 'store')), []);
  });
});
