import type { ProblemDetails } from './types';

/** Same-origin path; Next.js proxies it to the API (see next.config.ts). */
export const API_BASE = '/api/v1';

/** A non-2xx API response, with the RFC 9457 problem details when the API sent them. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, problem: ProblemDetails | null) {
    super(problem?.detail ?? `Request failed with status ${status}.`);
    this.name = 'ApiError';
    this.status = status;
    this.code = problem?.code;
  }
}

export function isApiError(error: unknown, status?: number): error is ApiError {
  return error instanceof ApiError && (status === undefined || error.status === status);
}

function isProblem(value: unknown): value is ProblemDetails {
  return typeof value === 'object' && value !== null && 'status' in value && 'code' in value;
}

type RequestOptions = { body?: unknown; csrfToken?: string; signal?: AbortSignal };

/**
 * Sends a same-origin request. The HttpOnly session cookie is attached by the browser and is
 * never read or stored by script. Responses are never cached.
 */
export async function apiRequest<T>(method: 'GET' | 'POST', path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.csrfToken) headers['x-csrf-token'] = options.csrfToken;

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  if (response.status === 204) return undefined as T;
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, isProblem(data) ? data : null);
  return data as T;
}
