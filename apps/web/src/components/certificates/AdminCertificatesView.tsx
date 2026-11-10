'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import { formatDate } from '@/lib/i18n/messages';
import type { CertificatePage } from '@/lib/api/types';
import { CertificateStatusBadge } from './certificateDisplay';

type Filter = 'all' | 'issued' | 'revoked';
type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: CertificatePage };

export function AdminCertificatesView() {
  return <RequireAuth role="administrator">{() => <Content />}</RequireAuth>;
}

/** Administrators: every certificate, newest first; each one opens with its issue and revocation history. */
function Content() {
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const c = t.certificates;
  const [filter, setFilter] = useState<Filter>('all');
  const [state, setState] = useState<Load>({ status: 'loading' });
  useEffect(() => {
    setState({ status: 'loading' });
    api
      .listAllCertificates(filter === 'all' ? {} : { status: filter })
      .then((data) => setState({ status: 'ready', data }))
      .catch((error: unknown) => {
        if (isApiError(error, 401)) handleUnauthorized();
        setState({ status: 'error', message: describeApiError(error, locale) });
      });
  }, [filter, handleUnauthorized, locale]);
  return (
    <div className="space-y-6">
      <PageHeader title={c.admin.title} description={c.admin.intro} breadcrumbLabel={t.common.breadcrumb} breadcrumbs={[{ label: t.nav.adminOverview, href: '/admin' }, { label: c.title }]} />
      <div role="group" aria-label={c.admin.filter} className="flex flex-wrap gap-2">
        {(['all', 'issued', 'revoked'] as const).map((value) => (
          <Button key={value} size="sm" variant={filter === value ? 'primary' : 'secondary'} aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {value === 'all' ? c.admin.all : c.status[value]}
          </Button>
        ))}
      </div>
      {state.status === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          {c.loading}
        </p>
      ) : state.status === 'error' ? (
        <Alert tone="error">{state.message}</Alert>
      ) : state.data.items.length === 0 ? (
        <p className="text-sm text-slate-600">{c.admin.none}</p>
      ) : (
        <ul className="space-y-2">
          {state.data.items.map((certificate) => (
            <li key={certificate.id} data-certificate={certificate.certificateNumber}>
              <Card className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium break-words text-slate-900">{certificate.recipientName}</p>
                  <p className="text-sm break-words text-slate-600">
                    {certificate.courseTitle} ({certificate.courseCode})
                  </p>
                  <p className="text-xs text-slate-500">
                    <span className="font-mono">{certificate.certificateNumber}</span> · {c.issuedOn(formatDate(certificate.issuedAt, locale))}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <CertificateStatusBadge status={certificate.status} />
                  <Link href={`/certificates/${certificate.id}`} className="text-sm font-medium text-brand-700 hover:underline">
                    {c.details}
                  </Link>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
