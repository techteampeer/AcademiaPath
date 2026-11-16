import { SCORM_LIMITS } from './limits.js';

/**
 * AP-033B path rules. Archive entry names and manifest addresses come from an untrusted package, so they are checked
 * as text only: nothing is ever resolved against the server's file system.
 */
export type EntryNameProblem = 'traversal' | 'absolute' | 'invalid';

const CONTROL = /[\u0000-\u001f\u007f]/;

/** Checks one ZIP entry name (a folder name ends with "/"). */
export function checkEntryName(name: string): EntryNameProblem | null {
  if (!name || CONTROL.test(name) || name.includes('\\') || name.includes('�')) return 'invalid';
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'absolute';
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
  const segments = trimmed.split('/');
  if (segments.includes('..')) return 'traversal';
  if (segments.some((segment) => segment === '' || segment === '.' || segment.includes(':'))) return 'invalid';
  if (Buffer.byteLength(name, 'utf8') > SCORM_LIMITS.maxPathBytes || segments.length > SCORM_LIMITS.maxPathDepth) return 'invalid';
  return null;
}

/** Key under which two names count as the same file on a case-insensitive or Unicode-normalizing system. */
export const collisionKey = (path: string) => path.normalize('NFC').toLowerCase();

export type HrefResult =
  | { kind: 'local'; path: string; query: string; fragment: string; backslash: boolean }
  | { kind: 'external'; value: string }
  | { kind: 'dangerous'; scheme: string }
  | { kind: 'invalid' }
  | { kind: 'outside' };

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/** Splits a URI reference, or classifies it as external, dangerous or invalid. */
function parseReference(raw: string): { kind: 'relative'; path: string; query: string; fragment: string; backslash: boolean } | Exclude<HrefResult, { kind: 'local' } | { kind: 'outside' }> {
  const value = raw.trim();
  if (!value || value.length > 2048 || CONTROL.test(value)) return { kind: 'invalid' };
  const scheme = SCHEME.exec(value)?.[1]?.toLowerCase();
  if (scheme) return scheme === 'http' || scheme === 'https' ? { kind: 'external', value } : { kind: 'dangerous', scheme };
  const backslash = value.includes('\\');
  const text = value.replaceAll('\\', '/');
  if (text.startsWith('//')) return { kind: 'external', value };
  if (text.startsWith('/')) return { kind: 'invalid' };
  const hash = text.indexOf('#');
  const beforeHash = hash === -1 ? text : text.slice(0, hash);
  const fragment = hash === -1 ? '' : text.slice(hash);
  const question = beforeHash.indexOf('?');
  return {
    kind: 'relative',
    path: question === -1 ? beforeHash : beforeHash.slice(0, question),
    query: question === -1 ? '' : beforeHash.slice(question),
    fragment,
    backslash,
  };
}

/**
 * Resolves an `href` against its `xml:base` values (outermost first) to a package-relative file path. Percent-escapes
 * are decoded; "." and ".." are applied, and a path that would climb above the package root is reported as outside.
 */
export function resolveHref(href: string, bases: Array<string | null | undefined> = []): HrefResult {
  const segments: string[] = [];
  let backslash = false;
  const parts = [...bases.filter((base): base is string => typeof base === 'string' && base.trim() !== ''), href];
  let final: { query: string; fragment: string } = { query: '', fragment: '' };
  for (const [index, part] of parts.entries()) {
    const parsed = parseReference(part);
    if (parsed.kind !== 'relative') return parsed;
    backslash ||= parsed.backslash;
    const isLast = index === parts.length - 1;
    // Every xml:base names a folder, with or without a trailing "/" (packages often omit it).
    for (const piece of parsed.path.split('/')) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(piece);
      } catch {
        return { kind: 'invalid' };
      }
      if (decoded.includes('/') || decoded.includes('\\') || CONTROL.test(decoded) || decoded.includes(':')) return { kind: 'invalid' };
      if (decoded === '' || decoded === '.') continue;
      if (decoded === '..') {
        if (!segments.length) return { kind: 'outside' };
        segments.pop();
        continue;
      }
      segments.push(decoded);
    }
    if (isLast) final = { query: parsed.query, fragment: parsed.fragment };
  }
  if (!segments.length) return { kind: 'invalid' };
  const path = segments.join('/');
  if (Buffer.byteLength(path, 'utf8') > SCORM_LIMITS.maxPathBytes) return { kind: 'invalid' };
  return { kind: 'local', path, query: final.query, fragment: final.fragment, backslash };
}
