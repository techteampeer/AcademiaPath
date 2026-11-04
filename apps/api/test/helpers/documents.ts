/**
 * Synthetic test documents built in code (no binary fixtures in the repository): a minimal PDF writer,
 * a ZIP writer that can also produce malformed or hostile archives, and minimal DOCX/PPTX packages.
 */
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';

const latin1 = (value: string) => Buffer.from(value, 'latin1');

/** PDF string literal in WinAnsi (Latin-1) with escapes, so Spanish accents survive. */
function pdfString(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char === '(' || char === ')' || char === '\\') out += `\\${char}`;
    else if (code < 32 || code > 126) out += `\\${(code & 0xff).toString(8).padStart(3, '0')}`;
    else out += char;
  }
  return `(${out})`;
}

/**
 * One page per entry; each line drawn with Helvetica on a wide page (pdf.js ignores text outside the
 * page area). `pages: [[]]` gives a page without text (a filled rectangle only).
 */
export function makePdf(pages: string[][], options: { compress?: boolean; encryptMarker?: boolean; header?: string } = {}): Buffer {
  const objects: Buffer[] = [];
  const add = (body: Buffer) => objects.push(body) - 1 + 1;
  const catalog = add(Buffer.alloc(0));
  const pagesId = add(Buffer.alloc(0));
  const font = add(latin1('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  const pageIds: number[] = [];
  for (const lines of pages) {
    const ops = lines.length ? `BT /F1 12 Tf 72 760 Td 16 TL ${lines.map((line) => `${pdfString(line)} Tj T*`).join(' ')} ET` : '0 0 1 rg 100 100 200 200 re f';
    const raw = latin1(ops);
    const data = options.compress ? deflateSync(raw) : raw;
    const content = add(Buffer.concat([latin1(`<< /Length ${data.length}${options.compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n`), data, latin1('\nendstream')]));
    pageIds.push(add(latin1(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 1400 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`)));
  }
  objects[catalog - 1] = latin1(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  objects[pagesId - 1] = latin1(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);

  const chunks: Buffer[] = [latin1(`${options.header ?? '%PDF-1.4'}\n%\xe2\xe3\xcf\xd3\n`)];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    const chunk = Buffer.concat([latin1(`${index + 1} 0 obj\n`), body, latin1('\nendobj\n')]);
    chunks.push(chunk);
    offset += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`)].join('');
  const encrypt = options.encryptMarker ? ` /Encrypt << /Filter /Standard /V 1 /R 2 /O (x) /U (y) /P -4 >>` : '';
  chunks.push(latin1(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${encrypt} >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

export type ZipEntry = {
  name: string;
  data: Buffer | string;
  /** Store without compression (default: deflate). */
  store?: boolean;
  /** General purpose flags (bit 0 = encrypted). */
  flags?: number;
  /** Forge the declared uncompressed size (central directory and local header). */
  declaredSize?: number;
};

/** Minimal ZIP writer (no data descriptors, no ZIP64). */
export function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const data = entry.store ? raw : deflateRawSync(raw);
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.store ? 0 : 8;
    const size = entry.declaredSize ?? raw.length;
    const flags = (entry.flags ?? 0) | 0x0800; // UTF-8 names
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

const xmlEscape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="MAIN"/></Relationships>`;

export const DOCX_MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
export const DOCM_MAIN = 'application/vnd.ms-word.document.macroEnabled.main+xml';
export const PPTX_MAIN = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';

const contentTypes = (part: string, type: string, extra = '') =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${part}" ContentType="${type}"/>${extra}</Types>`;

/** Word document whose paragraphs are given as text. Optional raw XML replaces the body. */
export function docxEntries(paragraphs: string[], options: { mainType?: string; bodyXml?: string; prefix?: string } = {}): ZipEntry[] {
  const body = options.bodyXml ?? paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`).join('');
  return [
    { name: '[Content_Types].xml', data: contentTypes('word/document.xml', options.mainType ?? DOCX_MAIN) },
    { name: '_rels/.rels', data: PACKAGE_RELS.replace('MAIN', 'word/document.xml') },
    { name: 'word/document.xml', data: `${options.prefix ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'}<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>` },
  ];
}

export const makeDocx = (paragraphs: string[], options: Parameters<typeof docxEntries>[1] = {}) => makeZip(docxEntries(paragraphs, options));

/** Presentation with one slide per entry (each string is one text paragraph), in the given order. */
export function makePptx(slides: string[][], options: { reverseParts?: boolean } = {}): Buffer {
  const count = slides.length;
  // Slide N in presentation order is stored as part slide{count-N+1} when reverseParts is set, to
  // prove that order comes from p:sldIdLst and not from part names.
  const partFor = (index: number) => `slides/slide${options.reverseParts ? count - index : index + 1}.xml`;
  const sldIds = slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 10}"/>`).join('');
  const rels = slides.map((_, index) => `<Relationship Id="rId${index + 10}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="${partFor(index)}"/>`).join('');
  const external = `<Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://attacker.example/track" TargetMode="External"/>`;
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: contentTypes('ppt/presentation.xml', PPTX_MAIN) },
    { name: '_rels/.rels', data: PACKAGE_RELS.replace('MAIN', 'ppt/presentation.xml') },
    { name: 'ppt/presentation.xml', data: `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${sldIds}</p:sldIdLst></p:presentation>` },
    { name: 'ppt/_rels/presentation.xml.rels', data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}${external}</Relationships>` },
  ];
  slides.forEach((paragraphs, index) => {
    const text = paragraphs.map((value) => `<a:p><a:r><a:t>${xmlEscape(value)}</a:t></a:r></a:p>`).join('');
    entries.push({
      name: `ppt/${partFor(index)}`,
      data: `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp><p:txBody>${text}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    });
  });
  return makeZip(entries);
}

export type FormPart = { name: string; value: string } | { name: string; filename: string; contentType?: string; data: Buffer };

/** multipart/form-data body for app.inject. */
export function multipartBody(parts: FormPart[]) {
  const boundary = `----academiapath-test-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('value' in part) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`));
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`,
        ),
        part.data,
        Buffer.from('\r\n'),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
