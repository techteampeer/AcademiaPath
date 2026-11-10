'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { contentAbilities } from '@/components/content/contentDisplay';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError, useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import { formatDate } from '@/lib/i18n/messages';
import type { Certificate, CertificatePolicy, Course, CourseCertificateEligibility, CurrentUser, MyCourseCertificates } from '@/lib/api/types';
import { CertificateStatusBadge, DownloadCertificateButton, EligibilityBadge, RequirementList } from './certificateDisplay';

type Load<T> = { status: 'loading' } | { status: 'not-found' } | { status: 'error'; message: string } | { status: 'ready'; data: T };

export function CourseCertificatesView({ courseId }: { courseId: string }) {
  return <RequireAuth>{(user) => <Content courseId={courseId} user={user} />}</RequireAuth>;
}

function useLoader<T>(fetcher: () => Promise<T>) {
  const { handleUnauthorized } = useSession();
  const { locale } = useLocale();
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', data: await fetcher() });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      else if (isApiError(error, 404) || isApiError(error, 400)) setState({ status: 'not-found' });
      else setState({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [fetcher, handleUnauthorized, locale]);
  useEffect(() => {
    void load();
  }, [load]);
  return { state, load };
}

function Content({ courseId, user }: { courseId: string; user: CurrentUser }) {
  const { t } = useLocale();
  const c = t.certificates;
  const fetchCourse = useCallback(() => api.getCourse(courseId), [courseId]);
  const { state } = useLoader<Course>(fetchCourse);
  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {c.loading}
      </p>
    );
  }
  if (state.status === 'not-found') return <EmptyState titleAs="h1" title={t.assignments.book.notAvailableTitle} description={t.assignments.book.notAvailableDescription} />;
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>;
  const course = state.data;
  const abilities = contentAbilities(user, course.viewerRole);
  return (
    <div className="space-y-6">
      <PageHeader
        title={c.title}
        kicker={course.code}
        breadcrumbLabel={t.common.breadcrumb}
        breadcrumbs={[{ label: t.nav.myCourses, href: '/courses' }, { label: course.title, href: `/courses/${courseId}` }, { label: c.title }]}
      />
      {abilities.viewCertificates ? (
        <StaffCertificates courseId={courseId} canManage={abilities.manageCertificates} />
      ) : course.viewerRole === 'student' ? (
        <StudentCertificates courseId={courseId} />
      ) : (
        <Alert tone="info">{t.assignments.book.notForRole}</Alert>
      )}
    </div>
  );
}

/** A student's own status: the requirements (released grades only) and their certificates in this course. */
function StudentCertificates({ courseId }: { courseId: string }) {
  const { t, locale } = useLocale();
  const c = t.certificates;
  const fetcher = useCallback(() => api.myCourseCertificates(courseId), [courseId]);
  const { state } = useLoader<MyCourseCertificates>(fetcher);
  if (state.status === 'loading') return <p className="text-sm text-slate-600">{c.loading}</p>;
  if (state.status !== 'ready') return <Alert tone="error">{state.status === 'error' ? state.message : c.verify.notFound}</Alert>;
  const { policy, eligibility, certificates } = state.data;
  return (
    <div className="space-y-4">
      <Card as="section" aria-labelledby="my-status-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="my-status-heading" className="font-semibold text-slate-900">
            {c.student.heading}
          </h2>
          {eligibility ? <EligibilityBadge eligible={eligibility.eligible} /> : null}
        </div>
        {!policy.configured || !eligibility ? (
          <p className="text-sm text-slate-600">{c.student.noPolicy}</p>
        ) : (
          <>
            <p className="text-sm text-slate-600">{eligibility.eligible ? c.student.eligibleNote : c.student.notEligibleNote}</p>
            <RequirementList eligibility={eligibility} />
            <p className="text-xs text-slate-500">{c.privacyNote}</p>
          </>
        )}
      </Card>
      {certificates.map((certificate) => (
        <Card as="article" key={certificate.id} className="flex flex-wrap items-center justify-between gap-3" data-certificate={certificate.certificateNumber}>
          <div className="min-w-0 space-y-1">
            <CertificateStatusBadge status={certificate.status} />
            <p className="text-sm text-slate-700">
              {c.number}: <span className="font-mono">{certificate.certificateNumber}</span> · {c.issuedOn(formatDate(certificate.issuedAt, locale))}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {certificate.status === 'issued' ? <DownloadCertificateButton certificateId={certificate.id} /> : null}
            <Link href={`/certificates/${certificate.id}`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
              {c.details}
            </Link>
          </div>
        </Card>
      ))}
    </div>
  );
}

/** Staff: the policy, every active student's eligibility, issuance and the issued certificates. */
function StaffCertificates({ courseId, canManage }: { courseId: string; canManage: boolean }) {
  const { t } = useLocale();
  const c = t.certificates;
  const fetchEligibility = useCallback(() => api.getCertificateEligibility(courseId), [courseId]);
  const fetchIssued = useCallback(() => api.listCourseCertificates(courseId), [courseId]);
  const eligibility = useLoader<CourseCertificateEligibility>(fetchEligibility);
  const issued = useLoader<{ items: Certificate[] }>(fetchIssued);
  const reload = () => {
    void eligibility.load();
    void issued.load();
  };
  if (eligibility.state.status === 'loading') return <p className="text-sm text-slate-600">{c.loading}</p>;
  if (eligibility.state.status !== 'ready') return <Alert tone="error">{eligibility.state.status === 'error' ? eligibility.state.message : c.verify.notFound}</Alert>;
  const data = eligibility.state.data;
  return (
    <div className="space-y-6">
      <PolicyForm courseId={courseId} policy={data.policy} canManage={canManage} onSaved={reload} />
      <Card as="section" aria-labelledby="eligibility-heading" className="space-y-3">
        <h2 id="eligibility-heading" className="font-semibold text-slate-900">
          {c.eligibility.heading}
        </h2>
        {data.items.length === 0 ? (
          <p className="text-sm text-slate-600">{c.eligibility.none}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.items.map((item) => (
              <li key={item.student.id} className="grid gap-3 py-3 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]" data-student={item.student.email}>
                <div className="min-w-0">
                  <p className="font-medium break-words text-slate-900">
                    {item.student.givenName} {item.student.familyName}
                  </p>
                  <p className="text-xs break-all text-slate-500">{item.student.email}</p>
                  <div className="mt-1">
                    <EligibilityBadge eligible={item.eligibility.eligible} />
                  </div>
                </div>
                <RequirementList eligibility={item.eligibility} compact />
                <div className="md:text-right">
                  {item.certificate ? (
                    <Link href={`/certificates/${item.certificate.id}`} className="text-sm font-medium text-brand-700 hover:underline">
                      {item.certificate.certificateNumber}
                    </Link>
                  ) : canManage && item.eligibility.eligible ? (
                    <IssueButton courseId={courseId} userId={item.student.id} onIssued={reload} />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card as="section" aria-labelledby="issued-heading" className="space-y-3">
        <h2 id="issued-heading" className="font-semibold text-slate-900">
          {c.issuedList.heading}
        </h2>
        {issued.state.status !== 'ready' ? (
          <p className="text-sm text-slate-600">{issued.state.status === 'error' ? issued.state.message : c.loading}</p>
        ) : issued.state.data.items.length === 0 ? (
          <p className="text-sm text-slate-600">{c.issuedList.none}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {issued.state.data.items.map((certificate) => (
              <IssuedRow key={certificate.id} courseId={courseId} certificate={certificate} canManage={canManage} onRevoked={reload} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function PolicyForm({ courseId, policy, canManage, onSaved }: { courseId: string; policy: CertificatePolicy; canManage: boolean; onSaved: () => void }) {
  const { t } = useLocale();
  const p = t.certificates.policy;
  const { run, pending, result } = useCsrfAction();
  const [enabled, setEnabled] = useState(policy.configured ? policy.enabled : true);
  const [requireCompletion, setRequireCompletion] = useState(policy.requireCompletion);
  const [requireFinalGrade, setRequireFinalGrade] = useState(policy.requireFinalGrade);
  const [minimum, setMinimum] = useState(policy.minimumGradePercent === null ? '' : String(policy.minimumGradePercent));
  const [issuer, setIssuer] = useState(policy.issuerName);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const minimumValue = minimum.trim() === '' ? null : Number(minimum);
    if (!requireCompletion && !requireFinalGrade) return setError(p.needOne);
    if (minimumValue !== null && (!Number.isInteger(minimumValue) || minimumValue < 1 || minimumValue > 100)) return setError(p.minimumRange);
    if (minimumValue !== null && !requireFinalGrade) return setError(p.minimumNeedsFinal);
    if (!issuer.trim()) return setError(p.issuerRequired);
    setError(null);
    const saved = await run(
      (csrf) => api.saveCertificatePolicy(courseId, { expectedVersion: policy.version, enabled, requireCompletion, requireFinalGrade, minimumGradePercent: minimumValue, issuerName: issuer.trim() }, csrf),
      () => p.saved,
    );
    if (saved) onSaved();
  };
  return (
    <Card as="section" aria-labelledby="policy-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="policy-heading" className="font-semibold text-slate-900">
          {p.heading}
        </h2>
        <span data-policy-configured={String(policy.configured)}>
          {policy.configured ? <Badge tone={policy.enabled ? 'success' : 'neutral'}>{p.version(policy.version)}</Badge> : null}
        </span>
      </div>
      <p className="text-sm text-slate-600">{p.intro}</p>
      {!policy.configured ? <Alert tone="info">{p.notConfigured}</Alert> : null}
      {!canManage ? <Alert tone="info">{p.readOnly}</Alert> : null}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={!canManage || pending} className="space-y-3">
          <legend className="sr-only">{p.heading}</legend>
          {[
            ['enabled', p.enabled, enabled, setEnabled],
            ['completion', p.requireCompletion, requireCompletion, setRequireCompletion],
            ['final', p.requireFinalGrade, requireFinalGrade, setRequireFinalGrade],
          ].map(([key, label, checked, set]) => (
            <label key={key as string} className="flex items-start gap-2 text-sm text-slate-800">
              <input type="checkbox" className="mt-1" checked={checked as boolean} onChange={(event) => (set as (value: boolean) => void)(event.target.checked)} />
              <span>{label as string}</span>
            </label>
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField id="certificate-minimum" label={p.minimum} hint={p.minimumHint} type="number" inputMode="numeric" min={1} max={100} step={1} value={minimum} onChange={(event) => setMinimum(event.target.value)} />
            <TextField id="certificate-issuer" label={p.issuer} maxLength={120} value={issuer} onChange={(event) => setIssuer(event.target.value)} />
          </div>
        </fieldset>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
        {canManage ? (
          <Button type="submit" disabled={pending}>
            {pending ? p.saving : p.save}
          </Button>
        ) : null}
      </form>
    </Card>
  );
}

function IssueButton({ courseId, userId, onIssued }: { courseId: string; userId: string; onIssued: () => void }) {
  const { t } = useLocale();
  const e = t.certificates.eligibility;
  const { run, pending, result } = useCsrfAction();
  const issue = async () => {
    const certificate = await run((csrf) => api.issueCertificate(courseId, userId, csrf), (value) => e.issued(value.certificateNumber));
    if (certificate) onIssued();
  };
  return (
    <div className="space-y-1">
      <Button size="sm" onClick={() => void issue()} disabled={pending}>
        {pending ? e.issuing : e.issue}
      </Button>
      {result?.tone === 'error' ? <Alert tone="error">{result.message}</Alert> : null}
    </div>
  );
}

function IssuedRow({ courseId, certificate, canManage, onRevoked }: { courseId: string; certificate: Certificate; canManage: boolean; onRevoked: () => void }) {
  const { t, locale } = useLocale();
  const c = t.certificates;
  const r = c.issuedList;
  const { run, pending, result } = useCsrfAction();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const revoke = async () => {
    if (!reason.trim()) return setError(r.reasonRequired);
    setError(null);
    const revoked = await run((csrf) => api.revokeCertificate(courseId, certificate.id, reason.trim(), csrf), () => r.revoked);
    if (revoked) {
      setConfirming(false);
      onRevoked();
    }
  };
  return (
    <li className="space-y-2 py-3" data-certificate={certificate.certificateNumber}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium break-words text-slate-900">{certificate.recipientName}</p>
          <p className="text-xs text-slate-500">
            <span className="font-mono">{certificate.certificateNumber}</span> · {c.issuedOn(formatDate(certificate.issuedAt, locale))}
            {certificate.revokedAt ? ` · ${c.revokedOn(formatDate(certificate.revokedAt, locale))}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CertificateStatusBadge status={certificate.status} />
          <Link href={`/certificates/${certificate.id}`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
            {c.details}
          </Link>
          {canManage && certificate.status === 'issued' && !confirming ? (
            <Button size="sm" variant="secondary" onClick={() => setConfirming(true)}>
              {r.revoke}
            </Button>
          ) : null}
        </div>
      </div>
      {confirming ? (
        <div role="alertdialog" aria-labelledby={`revoke-${certificate.id}`} className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p id={`revoke-${certificate.id}`} className="font-medium text-slate-900">
            {r.revokeTitle(certificate.certificateNumber)}
          </p>
          <p className="text-sm text-slate-700">{r.revokeBody}</p>
          <TextField id={`revoke-reason-${certificate.id}`} label={r.reason} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} error={error ?? undefined} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void revoke()} disabled={pending}>
              {pending ? r.revoking : r.confirm}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirming(false)} disabled={pending}>
              {r.cancel}
            </Button>
          </div>
        </div>
      ) : null}
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
    </li>
  );
}
