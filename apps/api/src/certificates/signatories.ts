/**
 * Certificate signatories (AP-043): up to three printed names with their official titles, in print order.
 * They are text only: AcademiaPath never produces handwritten, scanned, electronic or cryptographic
 * signatures, and a signatory is not linked to any user account.
 */
import { MAX_CERTIFICATE_SIGNATORIES, type CertificatePolicySnapshot, type CertificateSignatory } from '../db/schema/index.js';
import { printableOnCertificate } from './winansi.js';

export const SIGNATORY_NAME_MAX = 80;
export const SIGNATORY_TITLE_MAX = 100;

/** NFC, trimmed, with every run of whitespace turned into one space. */
const tidy = (value: string) => value.normalize('NFC').replace(/\s+/g, ' ').trim();
/** Comparison key for duplicates: case, accents and spacing are ignored ("José Pérez" = "jose  perez"). */
const sameName = (value: string) => tidy(value).normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es');

export type SignatoryCheck = { ok: true; signatories: CertificateSignatory[] } | { ok: false; detail: string };

/**
 * Validates and tidies signatories sent by a client (the JSON schema has already checked the shape, the
 * count and the raw lengths). Every entry needs a name and a title that print exactly on the certificate,
 * and a person appears at most once. The order given is the print order.
 */
export function checkSignatories(input: readonly CertificateSignatory[]): SignatoryCheck {
  if (input.length > MAX_CERTIFICATE_SIGNATORIES) return { ok: false, detail: `A certificate can have at most ${MAX_CERTIFICATE_SIGNATORIES} signatories.` };
  const signatories: CertificateSignatory[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of input.entries()) {
    const position = index + 1;
    const name = tidy(entry.name);
    const title = tidy(entry.title);
    if (!name || !title) return { ok: false, detail: `Signatory ${position} needs both a full name and an official title.` };
    if (name.length > SIGNATORY_NAME_MAX || title.length > SIGNATORY_TITLE_MAX) {
      return { ok: false, detail: `Signatory ${position}: names have at most ${SIGNATORY_NAME_MAX} characters and titles at most ${SIGNATORY_TITLE_MAX}.` };
    }
    if (!printableOnCertificate(name) || !printableOnCertificate(title)) {
      return { ok: false, detail: `Signatory ${position} contains characters that cannot be printed on the certificate (use Latin letters, including Spanish accents).` };
    }
    const key = sameName(name);
    if (seen.has(key)) return { ok: false, detail: `Signatory ${position} repeats another signatory: each person signs once.` };
    seen.add(key);
    signatories.push({ name, title });
  }
  return { ok: true, signatories };
}

/**
 * The signatories saved in a certificate's snapshot, in print order. Certificates issued before AP-043
 * have none; anything malformed is left out rather than shown.
 */
export function snapshotSignatories(snapshot: CertificatePolicySnapshot | null | undefined): CertificateSignatory[] {
  const list: unknown = snapshot?.signatories;
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry): entry is CertificateSignatory => !!entry && typeof entry === 'object' && typeof entry.name === 'string' && typeof entry.title === 'string' && !!entry.name && !!entry.title)
    .slice(0, MAX_CERTIFICATE_SIGNATORIES)
    .map(({ name, title }) => ({ name, title }));
}
