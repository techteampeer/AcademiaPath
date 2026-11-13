/**
 * Certificate PDF (AP-024), written locally without any external service or dependency: one A4 landscape
 * page using the standard Helvetica fonts (WinAnsi encoding, so Spanish accents print correctly). It is
 * generated only from the stored certificate record (its immutable snapshot), so the PDF always matches
 * what verification shows. It never contains e-mail addresses, grades or any other private data.
 */
import type { CertificateRecord, CertificateSignatory } from '../db/schema/index.js';
import { snapshotSignatories } from './signatories.js';
import { winAnsiBytes } from './winansi.js';

// Advance widths (1/1000 em) of the standard Helvetica fonts for printable ASCII (32–126).
const WIDTHS: Record<'regular' | 'bold', number[]> = {
  regular: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ],
  bold: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  ],
};

type Font = 'regular' | 'bold';
type Color = [number, number, number];
const BRAND: Color = [0.114, 0.306, 0.847];
const INK: Color = [0.059, 0.09, 0.165];
const MUTED: Color = [0.278, 0.333, 0.412];
const PAGE = { width: 842, height: 595 };

/** Width in points; accented letters take the width of their base letter, as in the Helvetica metrics. */
export function textWidth(text: string, font: Font, size: number): number {
  let units = 0;
  for (const char of text) {
    const base = char.normalize('NFD')[0] ?? char;
    const code = base.codePointAt(0)!;
    units += code >= 32 && code <= 126 ? WIDTHS[font][code - 32]! : 556;
  }
  return (units * size) / 1000;
}

/** Splits text into at most `maxLines` lines that fit `maxWidth` (the last line is shortened with "…"). */
function wrap(text: string, font: Font, size: number, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, font, size) <= maxWidth || !current) current = candidate;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = `${kept[maxLines - 1]} ${lines.slice(maxLines).join(' ')}`;
  while (textWidth(`${last}…`, font, size) > maxWidth && last.length > 1) last = last.slice(0, -1).trimEnd();
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

/** The text itself when it fits `maxWidth`, otherwise shortened with "…" so that it does. */
function clip(text: string, font: Font, size: number, maxWidth: number): string {
  if (textWidth(text, font, size) <= maxWidth) return text;
  let kept = text;
  while (kept.length > 1 && textWidth(`${kept}…`, font, size) > maxWidth) kept = kept.slice(0, -1).trimEnd();
  return `${kept}…`;
}

/** The largest size (down to `min`) at which the text fits on one line. */
function fit(text: string, font: Font, size: number, min: number, maxWidth: number): number {
  let current = size;
  while (current > min && textWidth(text, font, current) > maxWidth) current -= 0.5;
  return current;
}

const fmt = (value: number) => (Math.round(value * 100) / 100).toString();
const hex = (bytes: number[]) => bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');

class Canvas {
  readonly ops: string[] = [];
  text(value: string, x: number, y: number, font: Font, size: number, color: Color = INK) {
    this.ops.push(`BT /${font === 'bold' ? 'F2' : 'F1'} ${fmt(size)} Tf ${color.map(fmt).join(' ')} rg ${fmt(x)} ${fmt(y)} Td <${hex(winAnsiBytes(value))}> Tj ET`);
  }
  centered(value: string, y: number, font: Font, size: number, color: Color = INK) {
    this.text(value, (PAGE.width - textWidth(value, font, size)) / 2, y, font, size, color);
  }
  rect(x: number, y: number, width: number, height: number, lineWidth: number, color: Color) {
    this.ops.push(`${color.map(fmt).join(' ')} RG ${fmt(lineWidth)} w ${fmt(x)} ${fmt(y)} ${fmt(width)} ${fmt(height)} re S`);
  }
  line(x1: number, y1: number, x2: number, y2: number, lineWidth: number, color: Color) {
    this.ops.push(`${color.map(fmt).join(' ')} RG ${fmt(lineWidth)} w ${fmt(x1)} ${fmt(y1)} m ${fmt(x2)} ${fmt(y2)} l S`);
  }
}

export type PlacedText = { text: string; x: number; y: number; font: Font; size: number };
export type SignatoryBlock = { line: { x1: number; x2: number; y: number }; texts: PlacedText[]; column: { left: number; right: number } };

/** Signatory block geometry (AP-043): the signature line, then the printed name and title below it. */
export const SIGNATORY_LAYOUT = { lineY: 214, nameSize: 10, minNameSize: 8, titleSize: 8.5, minTitleSize: 7.5 } as const;
/** Baselines of the issue date and certificate number row, and its rule: the original ones, and with signatories. */
const DATE_ROW = { label: 170, value: 154, english: 139, rule: 122 } as const;
export const SIGNED_DATE_ROW = { label: 153, value: 139, english: 126, rule: 117 } as const;
/** The lowest baseline of the text above the signatories (the course period, after a two-line course title). */
const SIGNED_SHIFT = 22;
export const SIGNED_TEXT_FLOOR = 232 + SIGNED_SHIFT;
const COLUMNS: Record<number, { centers: number[]; textWidth: number; lineWidth: number }> = {
  1: { centers: [421], textWidth: 300, lineWidth: 220 },
  2: { centers: [281, 561], textWidth: 240, lineWidth: 200 },
  3: { centers: [181, 421, 661], textWidth: 200, lineWidth: 180 },
};

/** Lines of `text` at `size` within `maxWidth`, or null when more than `maxLines` would be needed. */
function linesWithin(text: string, font: Font, size: number, maxWidth: number, maxLines: number): string[] | null {
  const lines = wrap(text, font, size, maxWidth, Number.POSITIVE_INFINITY);
  return lines.length <= maxLines && lines.every((line) => textWidth(line, font, size) <= maxWidth) ? lines : null;
}

/**
 * Places one to three signatories side by side, left to right in policy order: a signature line for a
 * handwritten signature on the printed copy, the printed name (bold, one or two lines) and the official
 * title (one or two lines). Text shrinks to a minimum size, then wraps; anything still too long (only
 * possible for unusual input) is shortened with "…", so nothing ever overlaps a neighbour or the page.
 */
export function layoutSignatories(signatories: readonly CertificateSignatory[]): SignatoryBlock[] {
  const columns = COLUMNS[Math.min(signatories.length, 3)];
  if (!columns) return [];
  const { lineY, nameSize, minNameSize, titleSize, minTitleSize } = SIGNATORY_LAYOUT;
  return signatories.slice(0, 3).map((signatory, index) => {
    const center = columns.centers[index]!;
    const max = columns.textWidth;
    const texts: PlacedText[] = [];
    const place = (text: string, y: number, font: Font, size: number) => texts.push({ text, x: center - textWidth(text, font, size) / 2, y, font, size });

    let y = lineY - 13;
    const oneLineSize = fit(signatory.name, 'bold', nameSize, minNameSize, max);
    const nameLines =
      textWidth(signatory.name, 'bold', oneLineSize) <= max ? { lines: [signatory.name], size: oneLineSize } : { lines: wrap(signatory.name, 'bold', minNameSize, max, 2), size: minNameSize };
    for (const line of nameLines.lines) {
      place(clip(line, 'bold', nameLines.size, max), y, 'bold', nameLines.size);
      y -= 10;
    }
    y -= 1.5;
    const regular = linesWithin(signatory.title, 'regular', titleSize, max, 2);
    const titleLines = regular ? { lines: regular, size: titleSize } : { lines: linesWithin(signatory.title, 'regular', minTitleSize, max, 2) ?? wrap(signatory.title, 'regular', minTitleSize, max, 2), size: minTitleSize };
    for (const line of titleLines.lines) {
      place(clip(line, 'regular', titleLines.size, max), y, 'regular', titleLines.size);
      y -= 9;
    }
    return {
      line: { x1: center - columns.lineWidth / 2, x2: center + columns.lineWidth / 2, y: lineY },
      texts,
      column: { left: center - max / 2, right: center + max / 2 },
    };
  });
}

const dateIn = (locale: string, date: Date) => new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'America/Lima' }).format(date);
const pdfDate = (date: Date) => `D:${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;

/** The application-relative verification path (no live domain is assumed). */
export const verificationPath = (token: string) => `/verify/${token}`;

/** Builds the certificate PDF from the stored record. Deterministic: the same record gives the same bytes. */
export function certificatePdf(certificate: CertificateRecord): Buffer {
  const canvas = new Canvas();
  const width = 700;
  // Without signatories (every certificate issued before AP-043) the layout is exactly the original one.
  // With signatories, the text moves up (`up`) and the date row moves down to make room for them.
  const signatories = snapshotSignatories(certificate.policySnapshot);
  const up = signatories.length ? SIGNED_SHIFT : 0;
  const rows = signatories.length ? SIGNED_DATE_ROW : DATE_ROW;
  canvas.rect(24, 24, PAGE.width - 48, PAGE.height - 48, 3, BRAND);
  canvas.rect(34, 34, PAGE.width - 68, PAGE.height - 68, 0.75, BRAND);

  canvas.centered(certificate.issuerName.toUpperCase(), 520 + (up ? 8 : 0), 'bold', fit(certificate.issuerName.toUpperCase(), 'bold', 14, 9, width), BRAND);
  canvas.centered('CERTIFICADO DE FINALIZACIÓN', 465 + up, 'bold', 30);
  canvas.centered('Certificate of Completion', 438 + up, 'regular', 16, MUTED);
  canvas.centered('Se otorga a  ·  This certifies that', 398 + up, 'regular', 12, MUTED);
  canvas.centered(certificate.recipientName, 360 + up, 'bold', fit(certificate.recipientName, 'bold', 28, 14, width));
  canvas.line(221, 348 + up, 621, 348 + up, 0.75, MUTED);
  canvas.centered('por haber completado el curso  ·  for completing the course', 322 + up, 'regular', 12, MUTED);
  const titleLines = wrap(certificate.courseTitle, 'bold', 20, width, 2);
  titleLines.forEach((line, index) => canvas.centered(line, 290 + up - index * 24, 'bold', 20, BRAND));
  const period = [certificate.courseCode, certificate.programName, `${certificate.termName} (${certificate.academicYear})`].filter(Boolean).join('  ·  ');
  canvas.centered(period, (titleLines.length > 1 ? 232 : 256) + up, 'regular', fit(period, 'regular', 11, 7, width), MUTED);

  for (const block of layoutSignatories(signatories)) {
    canvas.line(block.line.x1, block.line.y, block.line.x2, block.line.y, 0.75, INK);
    for (const item of block.texts) canvas.text(item.text, item.x, item.y, item.font, item.size, item.font === 'bold' ? INK : MUTED);
  }

  canvas.text('Fecha de emisión · Issue date', 80, rows.label, 'regular', 9, MUTED);
  canvas.text(dateIn('es-PE', certificate.issuedAt), 80, rows.value, 'bold', 12);
  canvas.text(dateIn('en-GB', certificate.issuedAt), 80, rows.english, 'regular', 10, MUTED);
  const label = 'N.º de certificado · Certificate No.';
  canvas.text(label, PAGE.width - 80 - textWidth(label, 'regular', 9), rows.label, 'regular', 9, MUTED);
  canvas.text(certificate.certificateNumber, PAGE.width - 80 - textWidth(certificate.certificateNumber, 'bold', 12), rows.value, 'bold', 12);
  canvas.line(80, rows.rule, PAGE.width - 80, rows.rule, 0.5, MUTED);

  canvas.centered('Verifique la autenticidad de este certificado  ·  Verify the authenticity of this certificate', 100, 'regular', 9, MUTED);
  canvas.centered(verificationPath(certificate.verificationToken), 84, 'bold', 9.5, INK);
  canvas.centered(`Referencia de verificación · Verification reference: ${certificate.verificationToken}`, 68, 'regular', 7.5, MUTED);
  canvas.centered(`Emitido por ${certificate.issuerName} con AcademiaPath  ·  Issued by ${certificate.issuerName} with AcademiaPath`, 50, 'regular', 7.5, MUTED);

  const content = canvas.ops.join('\n');
  const info = (value: string) => `<${'feff'}${Array.from(value).map((char) => char.codePointAt(0)!.toString(16).padStart(4, '0')).join('')}>`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    `<< /Title ${info(`Certificate ${certificate.certificateNumber}`)} /Author ${info(certificate.issuerName)} /Producer (AcademiaPath) /CreationDate (${pdfDate(certificate.issuedAt)}) >>`,
  ];
  let body = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
