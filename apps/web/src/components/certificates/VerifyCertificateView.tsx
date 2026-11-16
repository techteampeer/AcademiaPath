'use client';

import { useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { Alert } from '@/components/ui/Alert';
import { Card } from '@/components/ui/Card';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import { formatDate, localizeTermName } from '@/lib/i18n/messages';
import type { CertificateVerification } from '@/lib/api/types';
import { CertificateStatusBadge, SignatoryList } from './certificateDisplay';

type State = { status: 'loading' } | { status: 'not-found' } | { status: 'error'; message: string } | { status: 'ready'; data: CertificateVerification };

/**
 * Public verification (no sign-in): only what is printed on the certificate, and whether it is valid or
 * revoked. Unknown and malformed references get the same message.
 */
export function VerifyCertificateView({ token }: { token: string }) {
  const { t, locale } = useLocale();
  const v = t.certificates.verify;
  const [state, setState] = useState<State>({ status: 'loading' });
  useEffect(() => {
    api
      .verifyCertificate(token)
      .then((data) => setState({ status: 'ready', data }))
      .catch((error: unknown) => {
        if (isApiError(error, 404) || isApiError(error, 400) || isApiError(error, 414)) setState({ status: 'not-found' });
        else setState({ status: 'error', message: t.errors.network });
      });
  }, [token, t.errors.network]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-[1.75rem] leading-tight font-semibold text-brand-600 sm:text-[2.1rem]">{v.title}</h1>
      {state.status === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          {v.checking}
        </p>
      ) : state.status === 'not-found' ? (
        <Alert tone="error">{v.notFound}</Alert>
      ) : state.status === 'error' ? (
        <Alert tone="error">{state.message}</Alert>
      ) : (
        <Card as="section" aria-labelledby="verification-result" className="space-y-4" data-verification={state.data.status}>
          <div className="flex flex-wrap items-center gap-3">
            <CertificateStatusBadge status={state.data.status === 'valid' ? 'issued' : 'revoked'} />
            <p id="verification-result" className={state.data.status === 'valid' ? 'font-semibold text-emerald-800' : 'font-semibold text-amber-800'}>
              {state.data.status === 'valid' ? v.valid : v.revoked}
            </p>
          </div>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[11rem_1fr]">
            {(
              [
                [v.recipient, state.data.recipientName],
                [v.course, state.data.courseTitle],
                [v.period, localizeTermName(state.data.academicPeriod, locale)],
                [v.issuer, state.data.issuerName],
                [v.issuedAt, formatDate(state.data.issuedAt, locale)],
                [v.number, state.data.certificateNumber],
                ...(state.data.revokedAt ? [[v.revokedAt, formatDate(state.data.revokedAt, locale)]] : []),
              ] as Array<[string, string]>
            ).map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-sm font-medium text-slate-500">{label}</dt>
                <dd className="text-sm break-words text-slate-900">{value}</dd>
              </div>
            ))}
            {state.data.signatories.length > 0 ? (
              <div className="contents">
                <dt className="text-sm font-medium text-slate-500">{v.signatories}</dt>
                <dd className="text-sm text-slate-900">
                  <SignatoryList signatories={state.data.signatories} />
                </dd>
              </div>
            ) : null}
          </dl>
          <p className="text-xs text-slate-500">{v.note}</p>
        </Card>
      )}
    </div>
  );
}
