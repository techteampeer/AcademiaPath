/** Text encoding of the certificate PDF: the standard Helvetica fonts with WinAnsi (cp1252) encoding. */

/** WinAnsi (cp1252) bytes: Latin-1 maps directly; a few typographic characters are mapped; anything else is "?". */
const CP1252: Record<string, number> = { '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97 };
export function winAnsiBytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text.replace(/[\u0000-\u001f\u007f]/g, ' ')) {
    const code = char.codePointAt(0)!;
    if (code >= 32 && code <= 126) bytes.push(code);
    else if (code >= 160 && code <= 255) bytes.push(code);
    else bytes.push(CP1252[char] ?? 63);
  }
  return bytes;
}

/** True when every character prints as itself in the certificate fonts (no "?" substitutes, no control characters). */
export function printableOnCertificate(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (!((code >= 32 && code <= 126) || (code >= 160 && code <= 255) || Object.hasOwn(CP1252, char))) return false;
  }
  return true;
}

