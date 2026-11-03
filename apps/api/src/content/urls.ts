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
