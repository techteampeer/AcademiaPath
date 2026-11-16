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
 * `code` is shown (or a generic Spanish message for a code without a description).
 */
export function describeApiError(error: unknown, locale: Locale = 'en'): string {
  const t = MESSAGES[locale].errors;
  if (isApiError(error, 401)) return t.sessionEnded;
  if (isApiError(error, 403) && error.code === 'FORBIDDEN') return t.notAllowed;
  if (isApiError(error)) {
    if (locale === 'en') return error.message;
    // Never fall back to the English detail in Spanish: unknown codes get a generic localized message.
    return (error.code ? t.codes[error.code] : undefined) ?? t.unexpected;
  }
  return t.network;
}

/** What `run` last produced: the failed request itself (described at render), or a success message and its language. */
type StoredResult = { tone: 'error'; error: unknown } | { tone: 'success'; message: string; locale: Locale } | null;

/**
 * Runs one state-changing request with the session's in-memory CSRF token. Failures are shown to
 * the user (in the interface language) and are never retried automatically.
 *
 * AP-I18N-01: a failure is described on every render, so an error already on screen follows the EN/ES switch.
 * A success message (built by the caller in the language of that moment) is dropped when the language changes
 * instead of staying on screen in the previous language.
 */
export function useCsrfAction() {
  const { getCsrfToken, handleUnauthorized } = useSession();
  const { locale } = useLocale();
  const [pending, setPending] = useState(false);
  const [stored, setStored] = useState<StoredResult>(null);

  async function run<T>(action: (csrfToken: string) => Promise<T>, successMessage?: (value: T) => string): Promise<T | null> {
    setPending(true);
    setStored(null);
    try {
      const value = await action(await getCsrfToken());
      if (successMessage) setStored({ tone: 'success', message: successMessage(value), locale });
      return value;
    } catch (error) {
      setStored({ tone: 'error', error });
      if (isApiError(error, 401)) handleUnauthorized();
      return null;
    } finally {
      setPending(false);
    }
  }

  const result: ActionResult =
    stored === null
      ? null
      : stored.tone === 'error'
        ? { tone: 'error', message: describeApiError(stored.error, locale) }
        : stored.locale === locale
          ? { tone: 'success', message: stored.message }
          : null;
  return { run, pending, result, clearResult: () => setStored(null) };
}
