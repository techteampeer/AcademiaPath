/**
 * Certificate signatories (AP-043) without a database: validation, reading saved snapshots, the PDF
 * signature-area layout and the rendered PDF (names, titles, order, no overlap or overflow). Synthetic data.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { certificatePdf, layoutSignatories, SIGNATORY_LAYOUT, SIGNED_DATE_ROW, SIGNED_TEXT_FLOOR, textWidth } from '../../src/certificates/pdf.js';
import { checkSignatories, snapshotSignatories } from '../../src/certificates/signatories.js';
import type { CertificateRecord, CertificateSignatory } from '../../src/db/schema/index.js';

const SIGNERS: CertificateSignatory[] = [
  { name: 'María Fernanda Quispe Huamán', title: 'Directora de Programas Académicos' },
  { name: 'Jorge Luis Paredes Salazar', title: 'Coordinador del Programa de Maestría' },
  { name: 'Rosa Elena Mamani Condori', title: 'Decana de la Facultad de Ingeniería y Ciencias Aplicadas' },
];
/** Long but realistic: up to the API limits (80 / 100 characters), never shortened. */
const LONG: CertificateSignatory[] = [
  { name: 'María de los Ángeles Fernández-Villanueva Santisteban de la Cruz', title: 'Vicerrectora Académica y de Investigación de la Facultad de Ciencias Empresariales y Económicas' },
  { name: 'Juan Carlos Huamaní Quispe-Rodríguez de Mendoza', title: 'Director de la Escuela de Posgrado y Coordinador General de Programas de Maestría y Doctorado' },
  { name: 'Ana Lucía Ccahuana Villavicencio de Huarancca', title: 'Secretaria General de la Universidad y Responsable del Registro de Grados y Títulos' },
];
/** Unusual input at the length limits (no spaces, widest letter): shortened with "…", still inside its column. */
const EXTREME: CertificateSignatory[] = [{ name: 'W'.repeat(80), title: 'W'.repeat(100) }, { name: 'M'.repeat(80), title: 'M'.repeat(100) }, { name: 'Ñ'.repeat(80), title: 'Á'.repeat(100) }];

const BASE: CertificateRecord = {
  id: '00000000-0000-4000-8000-000000000001',
  verificationToken: 'Qm9yZ2VzLXN5bnRoZXRpYy10b2tlbi1mb3ItdGVzdHMtMDEy',
  certificateNumber: 'AP-7K3M-Q9TX-2HDP',
  courseId: '00000000-0000-4000-8000-000000000002',
  userId: '00000000-0000-4000-8000-000000000003',
  enrollmentId: '00000000-0000-4000-8000-000000000004',
  recipientName: 'Lucía Valentina Ñahui Ccori',
  courseTitle: 'Fundamentos de Gestión de Servicios de TI',
  courseCode: 'ITIL4-F-2026-2-A',
  programName: 'Maestría en Gestión de Proyectos',
  termName: 'Semestre 2026-2',
  academicYear: 2026,
  issuerName: 'Universidad Sintética del Perú',
  policyVersion: 3,
  policySnapshot: { version: 3, requireCompletion: true, requireFinalGrade: true, minimumGradePercent: 60, issuerName: 'Universidad Sintética del Perú' },
  status: 'issued',
  issuedAt: new Date('2026-11-13T15:30:00.000Z'),
  issuedByUserId: '00000000-0000-4000-8000-000000000005',
  revokedAt: null,
  revokedByUserId: null,
  revocationReason: null,
  createdAt: new Date('2026-11-13T15:30:00.000Z'),
};
const LONG_TITLE: CertificateRecord = { ...BASE, programName: null, courseTitle: 'Gestión Avanzada de Proyectos de Transformación Digital en Instituciones de Educación Superior del Perú' };
const withSigners = (record: CertificateRecord, signatories: CertificateSignatory[]): CertificateRecord => ({ ...record, policySnapshot: { ...record.policySnapshot, signatories } });
const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

type Box = { text: string; left: number; right: number; bottom: number; top: number };
/** Every text run on the page with its box (descender to cap height), from pdf.js. */
async function textBoxes(pdf: Buffer): Promise<Box[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0 }).promise;
  assert.equal(document.numPages, 1);
  const items = (await (await document.getPage(1)).getTextContent()).items;
  const boxes: Box[] = [];
  for (const item of items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const [, , , , x, y] = item.transform as number[];
    boxes.push({ text: item.str, left: x!, right: x! + item.width, bottom: y! - 0.21 * item.height, top: y! + 0.72 * item.height });
  }
  return boxes;
}
const overlaps = (a: Box, b: Box) => a.left < b.right - 0.01 && b.left < a.right - 0.01 && a.bottom < b.top - 0.01 && b.bottom < a.top - 0.01;

describe('certificate signatories: validation (AP-043)', () => {
  it('6. tidies names and titles and accepts an empty list', () => {
    assert.deepEqual(checkSignatories([]), { ok: true, signatories: [] });
    const result = checkSignatories([{ name: '  María   Fernanda\tQuispe ', title: ' Directora  de Programas ' }]);
    assert.deepEqual(result, { ok: true, signatories: [{ name: 'María Fernanda Quispe', title: 'Directora de Programas' }] });
    const decomposed = checkSignatories([{ name: 'José Pérez', title: 'Rector' }]);
    assert.deepEqual(decomposed, { ok: true, signatories: [{ name: 'José Pérez', title: 'Rector' }] }, 'combining accents are composed (NFC) and print correctly');
  });

  it('5, 6. rejects too many, incomplete, unprintable and repeated signatories', () => {
    const rejected = (input: CertificateSignatory[], pattern: RegExp) => {
      const result = checkSignatories(input);
      assert.equal(result.ok, false, JSON.stringify(input));
      assert.match((result as { detail: string }).detail, pattern);
    };
    rejected([...SIGNERS, { name: 'Pedro Ruiz Gallo', title: 'Rector' }], /at most 3/);
    rejected([{ name: '   ', title: 'Rector' }], /full name and an official title/);
    rejected([SIGNERS[0]!, { name: 'Pedro Ruiz', title: ' \n' }], /Signatory 2 needs/);
    rejected([{ name: 'Li Wei 李伟', title: 'Rector' }], /cannot be printed/);
    rejected([{ name: 'Pedro Ruiz', title: 'Rector 🎓' }], /cannot be printed/);
    rejected([{ name: 'Pedro\u0007Ruiz', title: 'Rector' }], /cannot be printed/);
    rejected([{ name: 'José Pérez', title: 'Rector' }, { name: 'jose  PEREZ', title: 'Decano' }], /Signatory 2 repeats/);
    rejected([{ name: 'A'.repeat(81), title: 'Rector' }], /at most 80/);
  });

  it('7. keeps the order given', () => {
    const reversed = [...SIGNERS].reverse();
    assert.deepEqual(checkSignatories(reversed), { ok: true, signatories: reversed });
  });

  it('12. reads saved snapshots: none before AP-043, malformed entries left out', () => {
    assert.deepEqual(snapshotSignatories(BASE.policySnapshot), [], 'a certificate issued before AP-043 has no signatories');
    assert.deepEqual(snapshotSignatories(null), []);
    const odd = { ...BASE.policySnapshot, signatories: [null, { name: 'Ana Ruiz' }, { name: '', title: 'x' }, 'text', SIGNERS[0], { ...SIGNERS[1], extra: 'ignored' }, SIGNERS[2], SIGNERS[0]] } as never;
    assert.deepEqual(snapshotSignatories(odd), SIGNERS, 'only well-formed entries, at most three, without extra fields');
  });
});

describe('certificate signatories: PDF (AP-043)', () => {
  it('13. certificates without signatories render byte for byte as before AP-043', () => {
    // SHA-256 of the same records rendered by the renderer on main before AP-043 (commit 917258c).
    assert.equal(sha256(certificatePdf(BASE)), 'bfd217e5ac73a6662b23e39217ce26cbf65d553b44d3627d98ce03dc033ce96c');
    assert.equal(sha256(certificatePdf(LONG_TITLE)), 'cf4f6f1d76e43aea14f9e72c0a4593695be4f0ab94046b887117971923259801');
    assert.equal(sha256(certificatePdf(withSigners(BASE, []))), sha256(certificatePdf(BASE)), 'an empty list is the original layout');
  });

  it('9. the signature area: aligned columns, inside the page, clear of the text above and the date row below', () => {
    for (const signers of [SIGNERS, LONG, EXTREME]) {
      for (const count of [1, 2, 3]) {
        const blocks = layoutSignatories(signers.slice(0, count));
        assert.equal(blocks.length, count);
        assert.ok(blocks.every((block) => block.line.y === SIGNATORY_LAYOUT.lineY), 'signature lines share one baseline');
        assert.ok(SIGNED_TEXT_FLOOR - SIGNATORY_LAYOUT.lineY >= 35, 'room above the line for a handwritten signature on the printed copy');
        blocks.forEach((block, index) => {
          assert.ok(block.column.left >= 80 && block.column.right <= 762, `column ${index + 1} inside the margins`);
          if (index > 0) assert.ok(block.column.left >= blocks[index - 1]!.column.right + 20, 'columns keep a gap');
          assert.ok(block.line.x1 >= block.column.left && block.line.x2 <= block.column.right);
          assert.ok(block.texts.length >= 2 && block.texts.length <= 4, 'one or two lines each for the name and the title');
          for (const text of block.texts) {
            const width = textWidth(text.text, text.font, text.size);
            assert.ok(text.x >= block.column.left - 0.01 && text.x + width <= block.column.right + 0.01, `"${text.text}" stays in its column`);
            assert.ok(text.y + 0.72 * text.size < block.line.y, 'text below the signature line');
            assert.ok(text.y - 0.21 * text.size > SIGNED_DATE_ROW.label + 0.72 * 9 + 3, `"${text.text}" clear of the date row`);
            assert.ok(text.size >= 7.5, 'legible size');
          }
        });
      }
    }
  });

  it('9. long realistic names and titles are wrapped, never shortened; unusual input is shortened with "…"', () => {
    for (const count of [1, 2, 3]) {
      const printed = layoutSignatories(LONG.slice(0, count)).map((block) => block.texts.map((text) => text.text).join(' '));
      printed.forEach((text, index) => {
        assert.ok(!text.includes('…'), `${count} signatories: nothing shortened (${text})`);
        assert.equal(text, `${LONG[index]!.name} ${LONG[index]!.title}`);
      });
    }
    assert.ok(layoutSignatories(EXTREME).every((block) => block.texts.some((text) => text.text.endsWith('…'))));
  });

  it('2, 3, 4, 7, 8, 9. the PDF prints each name and title in order, with no overlapping or overflowing text', async () => {
    for (const record of [BASE, LONG_TITLE]) {
      for (const signers of [SIGNERS, LONG, EXTREME]) {
        for (const count of [1, 2, 3]) {
          const chosen = signers.slice(0, count);
          const boxes = await textBoxes(certificatePdf(withSigners(record, chosen)));
          const label = `${count} signatories, ${record === BASE ? 'one-line' : 'two-line'} course title, ${signers === SIGNERS ? 'typical' : signers === LONG ? 'long' : 'extreme'} text`;
          for (const box of boxes) assert.ok(box.left >= 34 && box.right <= 808 && box.bottom >= 34 && box.top <= 561, `${label}: "${box.text}" inside the border`);
          for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i]!, boxes[j]!), `${label}: "${boxes[i]!.text}" overlaps "${boxes[j]!.text}"`);
          }
          if (signers !== EXTREME) {
            const text = boxes.map((box) => box.text).join(' ');
            for (const signer of chosen) for (const word of `${signer.name} ${signer.title}`.split(' ')) assert.ok(text.includes(word), `${label}: prints "${word}"`);
            const firstName = chosen.map((signer) => boxes.find((box) => signer.name.startsWith(box.text))!);
            assert.ok(firstName.every(Boolean), `${label}: each name is printed`);
            for (let k = 1; k < firstName.length; k++) assert.ok(firstName[k]!.left > firstName[k - 1]!.right, `${label}: left to right in policy order`);
          }
          const all = boxes.map((box) => box.text).join(' ');
          assert.doesNotMatch(all, /firma electr|electronic signature|digitally signed|firmado digitalmente/i, 'no electronic signature claim');
        }
      }
    }
  });
});
