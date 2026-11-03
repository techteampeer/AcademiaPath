import { ApiProblem } from './errors.js';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const paginationQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
    cursor: { type: 'string', minLength: 1, maxLength: 512 },
  },
} as const;

/** `limit` always has a value after validation (schema default). */
export type PaginationQuery = { limit: number; cursor?: string };

export type Page<T> = { items: T[]; nextCursor: string | null };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque keyset cursor: the last row's sort key and id. */
export function encodeCursor(key: string | number, id: string): string {
  return Buffer.from(JSON.stringify([key, id])).toString('base64url');
}

const invalidCursor = () => new ApiProblem(400, 'INVALID_CURSOR', 'The pagination cursor is invalid.');

export function decodeCursor(cursor: string | undefined, keyType: 'string'): { key: string; id: string } | null;
export function decodeCursor(cursor: string | undefined, keyType: 'number'): { key: number; id: string } | null;
export function decodeCursor(cursor: string | undefined, keyType: 'string' | 'number') {
  if (cursor === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== keyType ||
    (keyType === 'number' && !Number.isInteger(parsed[0])) ||
    typeof parsed[1] !== 'string' ||
    !UUID_PATTERN.test(parsed[1])
  ) {
    throw invalidCursor();
  }
  return { key: parsed[0] as string | number, id: parsed[1] };
}

/** Builds a page from `limit + 1` fetched rows. */
export function toPage<T>(rows: T[], limit: number, keyOf: (row: T) => [string | number, string]): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(...keyOf(last)) : null };
}
