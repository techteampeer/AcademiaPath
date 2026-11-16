/**
 * mailto: links (RFC 6068) for composing an e-mail in the user's own e-mail application (AP-044). Nothing here sends
 * e-mail: the link only opens a new message that the user reviews and sends themselves.
 */

/**
 * Links longer than this may be cut off or refused by some e-mail applications and operating systems (about 2,000
 * characters is the common limit), so longer messages use the copy fallback instead.
 */
export const MAILTO_SAFE_LENGTH = 2000;

/** A plain address only: anything with spaces, separators, brackets or quotes is left out of every link. */
const SAFE_ADDRESS = /^[^\s,;<>()[\]"\\@]+@[^\s,;<>()[\]"\\@]+$/;
export const isSafeAddress = (address: string) => SAFE_ADDRESS.test(address);

/** Percent-encodes an address for a mailto link; "@" stays readable (RFC 6068 allows it). */
const encodeAddress = (address: string) => encodeURIComponent(address).replace(/%40/g, '@');
/** Percent-encodes a header value; line breaks become CRLF as RFC 6068 requires for the body. */
const encodeValue = (value: string) => encodeURIComponent(value.replace(/\r\n|\r|\n/g, '\r\n'));

export type MailtoParts = { to?: string[]; bcc?: string[]; subject?: string; body?: string };

/** Builds a mailto link. Unsafe addresses are dropped; empty fields are left out. */
export function mailtoHref({ to = [], bcc = [], subject = '', body = '' }: MailtoParts): string {
  const recipients = to.filter(isSafeAddress).map(encodeAddress).join(',');
  const fields: string[] = [];
  const hidden = bcc.filter(isSafeAddress);
  if (hidden.length > 0) fields.push(`bcc=${hidden.map(encodeAddress).join(',')}`);
  if (subject) fields.push(`subject=${encodeValue(subject)}`);
  if (body) fields.push(`body=${encodeValue(body)}`);
  return `mailto:${recipients}${fields.length ? `?${fields.join('&')}` : ''}`;
}

/**
 * How the message reaches the e-mail application:
 * - `complete`: one link with the recipients in BCC, the subject and the message;
 * - `paste-bcc`: too many addresses for one link: the link has the subject and message, the user pastes the copied BCC list;
 * - `copy-all`: the message itself is too long: the link has the subject only; the user pastes the BCC list and the message.
 */
export type ComposePlan = { mode: 'complete' | 'paste-bcc' | 'copy-all'; href: string; bccText: string; length: number };

/**
 * The sender's own address goes in To (so students only ever appear in BCC and never see each other's addresses);
 * nobody is placed in CC.
 */
export function composePlan(input: { self: string | null; recipients: string[]; subject: string; body: string }): ComposePlan {
  const to = input.self && isSafeAddress(input.self) ? [input.self] : [];
  const bcc = input.recipients.filter(isSafeAddress);
  const bccText = bcc.join(', ');
  const complete = mailtoHref({ to, bcc, subject: input.subject, body: input.body });
  if (complete.length <= MAILTO_SAFE_LENGTH) return { mode: 'complete', href: complete, bccText, length: complete.length };
  const withoutBcc = mailtoHref({ to, subject: input.subject, body: input.body });
  if (withoutBcc.length <= MAILTO_SAFE_LENGTH) return { mode: 'paste-bcc', href: withoutBcc, bccText, length: complete.length };
  return { mode: 'copy-all', href: mailtoHref({ to, subject: input.subject }), bccText, length: complete.length };
}
