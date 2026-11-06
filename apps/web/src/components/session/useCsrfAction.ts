'use client';

import { useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { isApiError } from '@/lib/api/client';
import { MESSAGES, type Locale } from '@/lib/i18n/messages';
import { useSession } from './SessionProvider';

export type ActionResult = { tone: 'success' | 'error'; message: string } | null;

/**
 * User-facing description of a failed request. The API's RFC 9457 `detail` is safe and specific but
 * English, so it is shown as-is in English; in Spanish the localized description of the problem
 * `code` is shown (falling back to the API's detail for unknown codes).
 */
export function describeApiError(error: unknown, locale: Locale = 'en'): string {
  const t = MESSAGES[locale].errors;
  if (isApiError(error, 401)) return t.sessionEnded;
  if (isApiError(error, 403) && error.code === 'FORBIDDEN') return t.notAllowed;
  if (isApiError(error)) {
    if (locale === 'en') return error.message;
    return (error.code ? t.codes[error.code] : undefined) ?? error.message;
  }
  return t.network;
}

/**
 * Runs one state-changing request with the session's in-memory CSRF token. Failures are shown to
 * the user (in the interface language) and are never retried automatically.
 */
export function useCsrfAction() {
  const { getCsrfToken, handleUnauthorized } = useSession();
  const { locale } = useLocale();
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
      setResult({ tone: 'error', message: describeApiError(error, locale) });
      if (isApiError(error, 401)) handleUnauthorized();
      return null;
    } finally {
      setPending(false);
    }
  }

  return { run, pending, result, clearResult: () => setResult(null) };
}
