import { ApiProblem } from '../http/errors.js';

type PgErrorInfo = { code: string; constraint?: string };

/** Finds the PostgreSQL error (SQLSTATE `code`, `constraint`) in a Drizzle error's cause chain. */
export function getPgError(error: unknown): PgErrorInfo | undefined {
  let current: unknown = error;
  while (current && typeof current === 'object') {
    if ('code' in current && typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code)) {
      return current as PgErrorInfo;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

/** Runs a write and turns a violation of the named unique constraint into a 409 problem. */
export async function withUniqueConflict<T>(
  write: () => Promise<T>,
  constraint: string,
  code: string,
  detail: string,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const pg = getPgError(error);
    if (pg?.code === '23505' && pg.constraint === constraint) {
      throw new ApiProblem(409, code, detail);
    }
    throw error;
  }
}
