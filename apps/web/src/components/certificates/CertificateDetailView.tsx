'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import { formatDate, formatDateTime, localizeTermName } from '@/lib/i18n/messages';
import type { Certificate } from '@/lib/api/types';
import { CertificateStatusBadge, DownloadCertificateButton, SignatoryList } from './certificateDisplay';

type Load = { status: 'loading' } | { status: 'not-found' } | { status: 'error'; message: string } | { status: 'ready'; data: Certificate };

export function CertificateDetailView({ certificateId }: { certificateId: string }) {
  return <RequireAuth>{() => <Content certificateId={certificateId} />}</RequireAuth>;
}

/** One certificate exactly as issued (its snapshot), for the recipient, course staff or administrators. */
function Content({ certificateId }: { certificateId: string }) {
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const c = t.certificates;
  const [state, setState] = useState<Load>({ status: 'loading' });
  useEffect(() => {
    api
      .getCertificate(certificateId)
      .then((data) => setState({ status: 'ready', data }))
      .catch((error: unknown) => {
        if (isApiError(error, 401)) handleUnauthorized();
        else if (isApiError(error, 404) || isApiError(error, 400)) setState({ status: 'not-found' });
        else setState({ status: 'error', message: describeApiError(error, locale) });
      });
  }, [certificateId, handleUnauthorized, locale]);

  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {c.loading}
      </p>
    );
  }
  if (state.status === 'not-found') return <EmptyState titleAs="h1" title={c.verify.notFound} />;
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>;
  const certificate = state.data;
  const rows: Array<[string, string]> = [
    [c.verify.recipient, certificate.recipientName],
    [c.verify.course, `${certificate.courseTitle} (${certificate.courseCode})`],
    [c.verify.period, [certificate.programName, c.period(localizeTermName(certificate.termName, locale), certificate.academicYear)].filter(Boolean).join(' · ')],
    [c.verify.issuer, certificate.issuerName],
    [c.verify.issuedAt, formatDate(certificate.issuedAt, locale)],
    [c.number, certificate.certificateNumber],
  ];
  if (certificate.revokedAt) rows.push([c.verify.revokedAt, formatDate(certificate.revokedAt, locale)]);
  if (certificate.revocationReason) rows.push([c.reasonLabel, certificate.revocationReason]);
  return (
    <div className="space-y-6">
      <PageHeader
        title={certificate.courseTitle}
        kicker={c.title}
        breadcrumbLabel={t.common.breadcrumb}
        breadcrumbs={[{ label: c.myTitle, href: '/certificates' }, { label: certificate.certificateNumber }]}
        actions={certificate.status === 'issued' ? <DownloadCertificateButton certificateId={certificate.id} /> : null}
      />
      <Card as="section" aria-label={c.details} className="space-y-4">
        <CertificateStatusBadge status={certificate.status} />
        {certificate.status === 'revoked' ? <Alert tone="info">{c.revokedNotice}</Alert> : null}
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[12rem_1fr]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-sm font-medium text-slate-500">{label}</dt>
              <dd className="text-sm break-words text-slate-900">{value}</dd>
            </div>
          ))}
          {certificate.signatories.length > 0 ? (
            <div className="contents">
              <dt className="text-sm font-medium text-slate-500">{c.verify.signatories}</dt>
              <dd className="text-sm text-slate-900">
                <SignatoryList signatories={certificate.signatories} />
              </dd>
            </div>
          ) : null}
        </dl>
        <div className="space-y-1 border-t border-slate-200 pt-4">
          <Link href={certificate.verificationPath} className="text-sm font-medium break-all text-brand-700 hover:underline">
            {c.verifyLink}: {certificate.verificationPath}
          </Link>
          <p className="text-xs text-slate-500">{c.copyHint}</p>
        </div>
      </Card>
      {certificate.history ? (
        <Card as="section" aria-labelledby="history-heading" className="space-y-2">
          <h2 id="history-heading" className="font-semibold text-brand-600">
            {c.history}
          </h2>
          <ol className="space-y-1 text-sm">
            {certificate.history.map((event, index) => (
              <li key={index} data-history={event.action}>
                <span className="font-medium">{event.action === 'certificate.issued' ? c.historyIssued : c.historyRevoked}</span> · {formatDateTime(event.at, locale)}
                {event.actor ? ` · ${c.by(event.actor.name)}` : ''}
                {event.reason ? <span className="block text-slate-600">{event.reason}</span> : null}
              </li>
            ))}
          </ol>
        </Card>
      ) : null}
    </div>
  );
}
