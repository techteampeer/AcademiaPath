'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError, type ActionResult } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { isApiError } from '@/lib/api/client';
import { api, loadAll } from '@/lib/api/endpoints';
import type { AccountInvitation, Course, CourseRole } from '@/lib/api/types';
import { formatDateTime } from '@/lib/i18n/messages';

export const COURSE_ROLES: CourseRole[] = ['student', 'instructor', 'non_editing_instructor', 'design_team'];
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Localized message for an API failure: known codes in the interface language, otherwise the API's safe detail. */
export function useErrorMessage() {
  const { t, locale } = useLocale();
  return useCallback(
    (error: unknown) => {
      if (isApiError(error) && error.code && t.users.errors[error.code]) return t.users.errors[error.code]!;
      if (isApiError(error, 401)) return t.login.expired;
      return locale === 'en' ? describeApiError(error) : t.users.genericError;
    },
    [t, locale],
  );
}

/** Like useCsrfAction, with localized errors and the failing API code (for field-level messages). */
export function useUserAction() {
  const { getCsrfToken, handleUnauthorized } = useSession();
  const message = useErrorMessage();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionResult>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  async function run<T>(action: (csrfToken: string) => Promise<T>, success?: (value: T) => string): Promise<T | null> {
    setPending(true);
    setResult(null);
    setErrorCode(null);
    try {
      const value = await action(await getCsrfToken());
      if (success) setResult({ tone: 'success', message: success(value) });
      return value;
    } catch (error) {
      setResult({ tone: 'error', message: message(error) });
      setErrorCode(isApiError(error) ? (error.code ?? null) : null);
      if (isApiError(error, 401)) handleUnauthorized();
      return null;
    } finally {
      setPending(false);
    }
  }

  return { run, pending, result, errorCode, clear: () => setResult(null) };
}

/** Every course (administrators see all), for course pickers. */
export function useAllCourses() {
  const { handleUnauthorized } = useSession();
  const [courses, setCourses] = useState<{ status: 'loading' } | { status: 'error' } | { status: 'ready'; items: Course[] }>({ status: 'loading' });
  const load = useCallback(async () => {
    try {
      const items = await loadAll((page) => api.listCourses(page));
      setCourses({ status: 'ready', items: items.sort((a, b) => a.code.localeCompare(b.code)) });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setCourses({ status: 'error' });
    }
  }, [handleUnauthorized]);
  useEffect(() => {
    void load();
  }, [load]);
  return { courses, reload: load };
}

export const courseLabel = (course: Pick<Course, 'code' | 'title'>) => `${course.code} — ${course.title}`;

export function AccountStatusBadge({ isActive }: { isActive: boolean }) {
  const { t } = useLocale();
  return <Badge tone={isActive ? 'success' : 'neutral'}>{isActive ? t.users.statusActive : t.users.statusInactive}</Badge>;
}

export function ActivationBadge({ state }: { state: 'activated' | 'pending' }) {
  const { t } = useLocale();
  return <Badge tone={state === 'activated' ? 'brand' : 'warning'}>{state === 'activated' ? t.users.activated : t.users.pending}</Badge>;
}

export function SystemRoleBadge({ role }: { role: 'administrator' | 'user' }) {
  const { t } = useLocale();
  return <Badge tone={role === 'administrator' ? 'brand' : 'neutral'}>{role === 'administrator' ? t.roles.administrator : t.roles.user}</Badge>;
}

/**
 * The one-time activation link, shown only right after it was issued (kept in component state, never
 * stored). Clearly labelled as the synthetic local demonstration mechanism.
 */
export function ActivationLinkPanel({ invitation }: { invitation: AccountInvitation }) {
  const { t, locale } = useLocale();
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}${invitation.activationPath}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section aria-labelledby="activation-link-heading" className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <h3 id="activation-link-heading" className="font-semibold text-amber-900">
        {t.users.linkTitle}
      </h3>
      <p className="text-sm text-amber-900">
        {t.users.linkIntro} {t.users.linkExpires(formatDateTime(invitation.expiresAt, locale))}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="activation-link" className="block text-sm font-medium text-slate-800">
            {t.users.linkLabel}
          </label>
          <input
            id="activation-link"
            readOnly
            value={url}
            onFocus={(event) => event.currentTarget.select()}
            className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900"
          />
        </div>
        <Button variant="secondary" onClick={() => void copy()}>
          {t.users.copy}
        </Button>
      </div>
      {copied ? <Alert tone="success">{t.users.copied}</Alert> : null}
    </section>
  );
}
