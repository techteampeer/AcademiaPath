'use client';

import { useState } from 'react';
import { isApiError } from '@/lib/api/client';
import { useSession } from './SessionProvider';

export type ActionResult = { tone: 'success' | 'error'; message: string } | null;

export function describeApiError(error: unknown): string {
  if (isApiError(error, 401)) return 'Your session has ended. Sign in again.';
  if (isApiError(error, 403) && error.code === 'FORBIDDEN') return 'You are not allowed to perform this action.';
  // Other API errors carry a safe, human-readable RFC 9457 `detail`.
  if (isApiError(error)) return error.message;
  return 'The request failed. Check your connection and try again.';
}

/**
 * Runs one state-changing request with the session's in-memory CSRF token. Failures are shown to
 * the user and are never retried automatically.
 */
export function useCsrfAction() {
  const { getCsrfToken, handleUnauthorized } = useSession();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionResult>(null);

  async function run<T>(action: (csrfToken: string) => Promise<T>, successMessage?: (value: T) => string): Promise<T | null> {
    setPending(true);
    setResult(null);
    try {
      const value = await action(await getCsrfToken());
      if (successMessage) setResult({ tone: 'success', message: successMessage(value) });
      return value;
    } catch (error) {
      setResult({ tone: 'error', message: describeApiError(error) });
      if (isApiError(error, 401)) handleUnauthorized();
      return null;
    } finally {
      setPending(false);
    }
  }

  return { run, pending, result, clearResult: () => setResult(null) };
}
