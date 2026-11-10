const MAX_URL_LENGTH = 2048;

/**
 * Returns a normalized absolute http(s) URL, or null when the input is unsafe: other schemes
 * (javascript:, data:, file:…), relative URLs, embedded credentials, whitespace or control
 * characters. URLs are only stored and linked; the server never fetches them.
 */
export function normalizeSafeHttpUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > MAX_URL_LENGTH || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) {
    return null;
  }
  return url.href;
}

/** Resource kinds a link activity can declare. Every kind is only ever a link opened in a new tab. */
export const RESOURCE_KINDS = ['website', 'video', 'interactive'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

const IPV4_HOST = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * URL accepted for new or edited learning resources (AP-021): everything `normalizeSafeHttpUrl` requires,
 * plus `https:` only and a registered domain name (no IP literals, no `localhost` or single-label hosts).
 * Videos and interactive tools are referenced by URL only; nothing is embedded, fetched or executed.
 */
export function normalizeResourceUrl(raw: string): string | null {
  const href = normalizeSafeHttpUrl(raw);
  if (!href) return null;
  const url = new URL(href);
  const host = url.hostname;
  if (url.protocol !== 'https:') return null;
  if (host.startsWith('[') || IPV4_HOST.test(host) || !host.includes('.') || host.endsWith('.localhost') || host.endsWith('.')) return null;
  return url.href;
}
