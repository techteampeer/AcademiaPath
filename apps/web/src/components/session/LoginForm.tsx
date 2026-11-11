'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { BrandMark } from '@/components/layout/Header';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/Field';
import { isApiError } from '@/lib/api/client';
import type { Messages } from '@/lib/i18n/messages';
import { useSession } from './SessionProvider';
import { landingPathFor, safeNextPath } from './WorkspaceProvider';

type FieldErrors = { email?: string; password?: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Generic messages only: never reveal whether an account exists. */
function loginErrorMessage(t: Messages, error: unknown): string {
  if (isApiError(error, 401)) return t.login.invalid;
  if (isApiError(error, 429)) return t.login.rateLimited;
  if (isApiError(error, 400)) return t.login.badRequest;
  return t.login.unavailable;
}

/**
 * The existing secure sign-in (server session in an HttpOnly cookie, CSRF token in memory). After
 * sign-in the user goes back to the page they asked for, or to their role's landing page.
 */
export function LoginForm() {
  const { session, signIn } = useSession();
  const { t } = useLocale();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ next: string | null; expired: boolean }>({ next: null, expired: false });
  // The form only submits through script; until hydration the button stays disabled, so
  // credentials can never be sent by a plain HTML form submission.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNotice({ next: safeNextPath(params.get('next')), expired: params.get('expired') === '1' });
    setReady(true);
  }, []);

  useEffect(() => {
    if (session.status === 'authenticated' && !submitting) router.replace(notice.next ?? landingPathFor(session.user));
  }, [session, submitting, notice.next, router]);

  const validate = (): FieldErrors => {
    const errors: FieldErrors = {};
    if (!email.trim()) errors.email = t.login.emailRequired;
    else if (!EMAIL_PATTERN.test(email.trim())) errors.email = t.login.emailInvalid;
    if (!password) errors.password = t.login.passwordRequired;
    return errors;
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    setError(null);
    if (errors.email || errors.password) return;

    setSubmitting(true);
    try {
      const user = await signIn({ email: email.trim(), password });
      router.replace(notice.next ?? landingPathFor(user));
    } catch (signInError) {
      setError(loginErrorMessage(t, signInError));
      setSubmitting(false);
    } finally {
      setPassword('');
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-4xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-raised md:grid-cols-2">
      <section aria-label={t.login.tagline} className="relative isolate hidden flex-col justify-between overflow-hidden bg-brand-800 p-8 text-ivory md:flex">
        {/* eslint-disable-next-line @next/next/no-img-element -- static decorative SVG */}
        <img src="/heritage/campus-panorama.svg" alt="" aria-hidden="true" className="absolute inset-0 -z-10 h-full w-full object-cover object-[62%_center]" />
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-linear-to-b from-brand-900/90 via-brand-900/75 to-brand-900/85" />
        <div className="flex items-center gap-3">
          <BrandMark className="h-11 w-11" />
          <span className="font-serif text-2xl font-semibold tracking-wide">AcademiaPath</span>
        </div>
        <div>
          <p className="text-sm font-semibold tracking-[0.14em] text-gold-200 uppercase">{t.login.tagline}</p>
          <div aria-hidden="true" className="heritage-rule mt-3 w-28" />
          <p className="mt-4 font-serif text-xl leading-relaxed text-ivory">{t.login.pitch}</p>
        </div>
        <p className="text-xs text-gold-200">{t.common.devPreview}</p>
      </section>
      <div className="p-6 sm:p-10">
        <div className="flex items-center gap-2 md:hidden">
          <BrandMark />
          <span className="font-serif text-lg font-semibold text-brand-600">AcademiaPath</span>
        </div>
        <h1 className="mt-6 text-[1.75rem] font-semibold text-brand-600 md:mt-0">{t.login.title}</h1>
        <div aria-hidden="true" className="heritage-rule mt-2 w-20" />
        <p className="mt-3 text-sm text-slate-600">{t.login.subtitle}</p>
        {notice.expired ? (
          <Alert tone="info" className="mt-4">
            {t.login.expired}
          </Alert>
        ) : null}
        <form method="post" noValidate onSubmit={onSubmit} className="mt-6 space-y-4" aria-describedby={error ? 'login-error' : undefined}>
          {error ? (
            <div id="login-error">
              <Alert tone="error">{error}</Alert>
            </div>
          ) : null}
          <TextField
            id="login-email"
            label={t.login.email}
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={fieldErrors.email}
            required
          />
          <TextField
            id="login-password"
            label={t.login.password}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={fieldErrors.password}
            required
          />
          <Button type="submit" className="w-full" disabled={!ready || submitting}>
            {submitting ? t.login.submitting : t.login.submit}
          </Button>
        </form>
        <p className="mt-6 text-xs leading-relaxed text-slate-600">{t.login.accountHelp}</p>
      </div>
    </div>
  );
}
