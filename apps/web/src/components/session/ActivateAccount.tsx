'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { Alert } from '@/components/ui/Alert';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { TextField } from '@/components/ui/Field';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { ActivationPreview } from '@/lib/api/types';
import { formatDateTime } from '@/lib/i18n/messages';

type State =
  | { status: 'checking' }
  | { status: 'invalid' }
  | { status: 'error' }
  | { status: 'ready'; token: string; preview: ActivationPreview }
  | { status: 'done'; email: string };

/**
 * Public page reached through a single-use activation link (`/activate#token=…`). The token is read
 * from the URL fragment, which browsers never send to a server, and is removed from the address bar
 * and history immediately. It is only ever sent in request bodies. Activation does not sign in.
 */
export function ActivateAccount() {
  const { t, locale } = useLocale();
  const [state, setState] = useState<State>({ status: 'checking' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    // Read once (effects can run twice in development), then drop the fragment from the URL and history.
    if (tokenRef.current === null) {
      tokenRef.current = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
      window.history.replaceState(null, '', window.location.pathname);
    }
    const token = tokenRef.current;
    if (!token) {
      setState({ status: 'invalid' });
      return;
    }
    api
      .previewActivation(token)
      .then((preview) => setState({ status: 'ready', token, preview }))
      .catch((error: unknown) => setState(isApiError(error, 400) ? { status: 'invalid' } : { status: 'error' }));
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.status !== 'ready') return;
    const found: typeof errors = {};
    if (password.length < 12) found.password = t.activation.tooShort;
    if (confirm !== password) found.confirm = t.activation.mismatch;
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length) return;
    setPending(true);
    try {
      await api.activateAccount(state.token, password);
      setPassword('');
      setConfirm('');
      setState({ status: 'done', email: state.preview.email });
    } catch (error) {
      if (isApiError(error, 400) && error.code === 'INVITATION_INVALID') setState({ status: 'invalid' });
      else if (isApiError(error) && error.code === 'PASSWORD_TOO_WEAK') setErrors({ password: t.activation.weak });
      else if (isApiError(error, 429)) setFailure(t.activation.rateLimited);
      else setFailure(t.activation.failed);
    } finally {
      setPending(false);
    }
  };

  const wrap = (content: ReactNode) => <div className="mx-auto w-full max-w-lg space-y-4">{content}</div>;

  if (state.status === 'checking') {
    return wrap(
      <p role="status" className="text-sm text-slate-600">
        {t.activation.checking}
      </p>,
    );
  }
  if (state.status === 'invalid' || state.status === 'error') {
    return wrap(
      <EmptyState
        titleAs="h1"
        title={t.activation.invalidTitle}
        description={state.status === 'invalid' ? t.activation.invalidDescription : t.activation.failed}
        action={
          <Link href="/login" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
            {t.common.signIn}
          </Link>
        }
      />,
    );
  }
  if (state.status === 'done') {
    return wrap(
      <Card className="space-y-4">
        <h1 className="text-[1.75rem] leading-tight font-semibold text-brand-600">{t.activation.doneTitle}</h1>
        <Alert tone="success">{t.activation.doneDescription}</Alert>
        <Link href={`/login`} className={buttonClasses()}>
          {t.activation.goToSignIn}
        </Link>
      </Card>,
    );
  }

  const { preview } = state;
  return wrap(
    <Card className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-[1.75rem] leading-tight font-semibold text-brand-600">{t.activation.title}</h1>
        <p className="text-sm text-slate-600">{t.activation.intro}</p>
      </div>
      <dl className="rounded-lg bg-slate-50 p-3 text-sm">
        <dt className="text-slate-500">{t.activation.account}</dt>
        <dd className="font-medium text-slate-900">
          {preview.givenName} {preview.familyName}
        </dd>
        <dd className="break-all text-slate-700">{preview.email}</dd>
        <dd className="mt-1 text-xs text-slate-500">{t.activation.expires(formatDateTime(preview.expiresAt, locale))}</dd>
      </dl>
      <form noValidate onSubmit={submit} className="space-y-4">
        {/* Lets password managers associate the new password with the account. */}
        <input type="email" name="username" autoComplete="username" value={preview.email} readOnly hidden />
        <TextField
          id="activate-password"
          label={t.activation.password}
          type="password"
          autoComplete="new-password"
          value={password}
          maxLength={256}
          hint={t.activation.passwordHint}
          error={errors.password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <TextField
          id="activate-confirm"
          label={t.activation.confirm}
          type="password"
          autoComplete="new-password"
          value={confirm}
          maxLength={256}
          error={errors.confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {failure ? <Alert tone="error">{failure}</Alert> : null}
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? t.activation.submitting : t.activation.submit}
        </Button>
      </form>
      <p className="text-xs text-slate-500">{t.activation.demoNote}</p>
    </Card>,
  );
}
