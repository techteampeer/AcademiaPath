/**
 * CSV writing for the gradebook export (AP-023). Every field is quoted (RFC 4180, CRLF line ends), and any
 * text that a spreadsheet could read as a formula — starting with =, +, -, @, a tab or a carriage return,
 * possibly after leading spaces — is prefixed with an apostrophe, so it is shown as text and never run.
 */
const FORMULA_START = /^[\s]*[=+\-@\t\r]/;

export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

export function csvField(value: string | number | null): string {
  if (value === null) return '""';
  const text = typeof value === 'number' ? String(value) : neutralizeFormula(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/** A UTF-8 byte order mark first, so spreadsheet software reads accents (á, ñ) correctly. */
export function toCsv(rows: Array<Array<string | number | null>>): string {
  return '﻿' + rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}
