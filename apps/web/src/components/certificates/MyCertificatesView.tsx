'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import { formatDate } from '@/lib/i18n/messages';
import type { MyCertificates } from '@/lib/api/types';
import { CertificateStatusBadge, DownloadCertificateButton, EligibilityBadge } from './certificateDisplay';

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: MyCertificates };

export function MyCertificatesView() {
  return <RequireAuth>{() => <Content />}</RequireAuth>;
}

/** The student's certificates and, per course they study, whether a certificate can be issued. */
function Content() {
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const c = t.certificates;
  const [state, setState] = useState<Load>({ status: 'loading' });
  useEffect(() => {
    api
      .myCertificates()
      .then((data) => setState({ status: 'ready', data }))
      .catch((error: unknown) => {
        if (isApiError(error, 401)) handleUnauthorized();
        setState({ status: 'error', message: describeApiError(error, locale) });
      });
  }, [handleUnauthorized, locale]);

  return (
    <div className="space-y-6">
      <PageHeader title={c.myTitle} breadcrumbLabel={t.common.breadcrumb} />
      {state.status === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          {c.loading}
        </p>
      ) : state.status === 'error' ? (
        <Alert tone="error">{state.message}</Alert>
      ) : (
        <>
          <section aria-labelledby="my-certificates-heading" className="space-y-3">
            <h2 id="my-certificates-heading" className="text-lg font-semibold text-slate-900">
              {c.title}
            </h2>
            {state.data.certificates.length === 0 ? (
              <EmptyState title={c.noCertificates} />
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {state.data.certificates.map((certificate) => (
                  <li key={certificate.id} data-certificate={certificate.certificateNumber}>
                    <Card as="article" aria-labelledby={`certificate-${certificate.id}`} className="space-y-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <h3 id={`certificate-${certificate.id}`} className="font-semibold break-words text-slate-900">
                          {certificate.courseTitle}
                        </h3>
                        <CertificateStatusBadge status={certificate.status} />
                      </div>
                      <p className="text-sm text-slate-600">
                        {c.period(certificate.termName, certificate.academicYear)} · {c.issuedOn(formatDate(certificate.issuedAt, locale))}
                      </p>
                      <p className="text-xs text-slate-500">
                        {c.number}: <span className="font-mono">{certificate.certificateNumber}</span>
                      </p>
                      {certificate.status === 'revoked' ? <p className="text-sm text-amber-800">{c.revokedNotice}</p> : null}
                      <div className="flex flex-wrap gap-2">
                        {certificate.status === 'issued' ? <DownloadCertificateButton certificateId={certificate.id} /> : null}
                        <Link href={`/certificates/${certificate.id}`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
                          {c.details}
                        </Link>
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="my-courses-heading" className="space-y-3">
            <h2 id="my-courses-heading" className="text-lg font-semibold text-slate-900">
              {c.courses}
            </h2>
            {state.data.courses.length === 0 ? (
              <p className="text-sm text-slate-600">{c.noCourses}</p>
            ) : (
              <ul className="space-y-2">
                {state.data.courses.map((course) => (
                  <li key={course.courseId} data-course={course.code}>
                    <Card className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium break-words text-slate-900">{course.title}</p>
                        <p className="text-xs text-slate-500">{course.code}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {course.certificate ? (
                          <CertificateStatusBadge status={course.certificate.status} />
                        ) : course.certificatesEnabled && course.eligible !== null ? (
                          <EligibilityBadge eligible={course.eligible} />
                        ) : (
                          <Badge tone="neutral">{c.certificatesDisabled}</Badge>
                        )}
                        <Link href={`/courses/${course.courseId}/certificates`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
                          {c.viewCourse}
                        </Link>
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
