'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { TextField } from '@/components/ui/Field';
import { isApiError } from '@/lib/api/client';
import { useSession } from './SessionProvider';

type FieldErrors = { email?: string; password?: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Generic messages only: never reveal whether an account exists. */
function loginErrorMessage(error: unknown): string {
  if (isApiError(error, 401)) return 'Invalid email or password.';
  if (isApiError(error, 429)) return 'Too many sign-in attempts. Please wait a few minutes and try again.';
  if (isApiError(error, 400)) return 'Enter a valid email and password.';
  return 'Sign-in is unavailable right now. Please try again.';
}

export function LoginForm() {
  const { session, signIn } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The form only submits through script; until hydration the button stays disabled, so
  // credentials can never be sent by a plain HTML form submission.
  const [ready, setReady] = useState(false);

  useEffect(() => setReady(true), []);
  useEffect(() => {
    if (session.status === 'authenticated') router.replace('/dashboard');
  }, [session.status, router]);

  const validate = (): FieldErrors => {
    const errors: FieldErrors = {};
    if (!email.trim()) errors.email = 'Enter your email address.';
    else if (!EMAIL_PATTERN.test(email.trim())) errors.email = 'Enter a valid email address.';
    if (!password) errors.password = 'Enter your password.';
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
      await signIn({ email: email.trim(), password });
      router.replace('/dashboard');
    } catch (signInError) {
      setError(loginErrorMessage(signInError));
    } finally {
      setPassword('');
      setSubmitting(false);
    }
  };

  return (
    <Card padding="lg" className="mx-auto w-full max-w-md">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Sign in</h1>
      <p className="mt-1 text-sm text-slate-600">Use your AcademiaPath account.</p>
      <form method="post" noValidate onSubmit={onSubmit} className="mt-6 space-y-4" aria-describedby={error ? 'login-error' : undefined}>
        {error ? (
          <div id="login-error">
            <Alert tone="error">{error}</Alert>
          </div>
        ) : null}
        <TextField
          id="login-email"
          label="Email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={fieldErrors.email}
          required
        />
        <TextField
          id="login-password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={fieldErrors.password}
          required
        />
        <Button type="submit" className="w-full" disabled={!ready || submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </Card>
  );
}
