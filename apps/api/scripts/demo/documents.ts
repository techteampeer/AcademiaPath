/**
 * DEVELOPMENT ONLY: synthetic demo documents generated in memory (no binary files in the repository).
 * Produces small, valid A4 PDFs (Helvetica, WinAnsi text) and minimal Word (.docx) packages. Both are marked as
 * synthetic in their document properties rather than in the body text, so the extractive mock summary never
 * quotes a footer as a key point.
 */
import { crc32, deflateRawSync } from 'node:zlib';

const latin1 = (value: string) => Buffer.from(value, 'latin1');
const SYNTHETIC = 'Synthetic demonstration material - AcademiaPath';

/** Keeps text within WinAnsi/Latin-1 (Spanish accents are kept; typographic dashes and quotes are simplified). */
function plain(text: string): string {
  return text.replace(/[—–]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...');
}

function pdfString(text: string): string {
  let out = '';
  for (const char of plain(text)) {
    const code = char.charCodeAt(0);
    if (char === '(' || char === ')' || char === '\\') out += `\\${char}`;
    else if (code < 32 || code > 126) out += `\\${(code & 0xff).toString(8).padStart(3, '0')}`;
    else out += char;
  }
  return `(${out})`;
}

function wrap(paragraph: string, width = 84): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of plain(paragraph).split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** A4 PDF: a title on the first page, then the given paragraphs, one array of paragraphs per page. */
export function demoPdf(title: string, pages: string[][]): Buffer {
  const objects: Buffer[] = [];
  const add = (body: Buffer) => objects.push(body);
  add(Buffer.alloc(0)); // 1 catalog (filled below)
  add(Buffer.alloc(0)); // 2 pages (filled below)
  add(latin1('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')); // 3
  add(latin1('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')); // 4
  const pageIds: number[] = [];
  pages.forEach((paragraphs, index) => {
    const ops: string[] = ['BT'];
    let y = 780;
    if (index === 0) {
      ops.push(`/F2 16 Tf 56 ${y} Td ${pdfString(title)} Tj`);
      y -= 34;
      ops.push(`0 -34 Td`);
    } else {
      ops.push(`56 ${y} Td`);
    }
    ops.push('/F1 11 Tf 15 TL');
    for (const paragraph of paragraphs) {
      for (const line of wrap(paragraph)) ops.push(`${pdfString(line)} Tj T*`);
      ops.push('T*');
    }
    ops.push('ET');
    const stream = latin1(ops.join('\n'));
    add(Buffer.concat([latin1(`<< /Length ${stream.length} >>\nstream\n`), stream, latin1('\nendstream')]));
    const contentId = objects.length;
    add(latin1(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`));
    pageIds.push(objects.length);
  });
  objects[0] = latin1('<< /Type /Catalog /Pages 2 0 R >>');
  objects[1] = latin1(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  add(latin1(`<< /Title ${pdfString(title)} /Subject ${pdfString(SYNTHETIC)} /Producer (AcademiaPath demo seed) >>`));
  const infoId = objects.length;
  const chunks: Buffer[] = [latin1('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    const chunk = Buffer.concat([latin1(`${index + 1} 0 obj\n`), body, latin1('\nendobj\n')]);
    chunks.push(chunk);
    offset += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`)].join('');
  chunks.push(latin1(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

function zip(entries: Array<{ name: string; data: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(entry.data, 'utf8');
    const data = deflateRawSync(raw);
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Minimal Word document: a bold title, then paragraphs (lines starting with "## " become bold headings). */
export function demoDocx(title: string, paragraphs: string[]): Buffer {
  const run = (text: string, bold: boolean, size?: number) =>
    `<w:r>${bold || size ? `<w:rPr>${bold ? '<w:b/>' : ''}${size ? `<w:sz w:val="${size}"/>` : ''}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
  const body = [
    `<w:p>${run(title, true, 32)}</w:p>`,
    ...paragraphs.map((text) => (text.startsWith('## ') ? `<w:p>${run(text.slice(3), true, 26)}</w:p>` : `<w:p>${run(text, false)}</w:p>`)),
  ].join('');
  return zip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
    },
    {
      name: 'docProps/core.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(title)}</dc:title><dc:subject>${SYNTHETIC}</dc:subject><dc:creator>AcademiaPath demo seed</dc:creator></cp:coreProperties>`,
    },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    },
  ]);
}
