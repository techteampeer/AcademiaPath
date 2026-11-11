'use client';

import { useState, type FormEvent } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SelectField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { tableClasses } from '@/components/ui/table';
import { api } from '@/lib/api/endpoints';
import type { EnrollmentImportResult } from '@/lib/api/types';
import { courseLabel, useAllCourses, useUserAction } from './userShared';

export function EnrollmentImport() {
  return <RequireAuth role="administrator">{() => <ImportContent />}</RequireAuth>;
}

function ImportContent() {
  const { t } = useLocale();
  const { courses } = useAllCourses();
  const previewAction = useUserAction();
  const applyAction = useUserAction();
  const [courseId, setCourseId] = useState('');
  const [csv, setCsv] = useState('');
  const [report, setReport] = useState<{ courseId: string; csv: string; result: EnrollmentImportResult } | null>(null);

  const preview = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!courseId || !csv.trim()) return;
    applyAction.clear();
    const result = await previewAction.run((csrf) => api.importEnrollments(courseId, csv, false, csrf));
    setReport(result ? { courseId, csv, result } : null);
  };

  const apply = async () => {
    if (!report) return;
    const result = await applyAction.run(
      (csrf) => api.importEnrollments(report.courseId, report.csv, true, csrf),
      (value) => t.users.applied(value.summary.create),
    );
    if (result) setReport({ ...report, result });
  };

  const stale = report !== null && (report.courseId !== courseId || report.csv !== csv);
  const summary = report?.result.summary;
  const canApply = report !== null && !stale && !report.result.applied && summary!.errors === 0 && summary!.create > 0;
  const outcomeLabel = (outcome: 'create' | 'unchanged' | 'error') =>
    outcome === 'error' ? t.users.outcomeError : outcome === 'unchanged' ? t.users.outcomeUnchanged : report?.result.applied ? t.users.outcomeCreated : t.users.outcomeCreate;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: t.nav.adminOverview, href: '/admin' },
          { label: t.users.title, href: '/admin/users' },
          { label: t.users.importTitle },
        ]}
        breadcrumbLabel={t.common.breadcrumb}
        title={t.users.importTitle}
        description={t.users.importIntro}
      />
      <Card>
        <form noValidate onSubmit={preview} className="space-y-4">
          <SelectField
            id="import-course"
            label={t.users.course}
            value={courseId}
            onChange={(e) => setCourseId(e.target.value)}
            options={[
              { value: '', label: t.users.selectCourse },
              ...(courses.status === 'ready' ? courses.items.map((course) => ({ value: course.id, label: courseLabel(course) })) : []),
            ]}
          />
          <div>
            <label htmlFor="import-csv" className="block text-sm font-medium text-slate-800">
              {t.users.csvLabel}
            </label>
            <textarea
              id="import-csv"
              rows={8}
              value={csv}
              maxLength={100_000}
              spellCheck={false}
              aria-describedby="import-csv-hint"
              onChange={(e) => setCsv(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 shadow-sm"
              placeholder={'email,role\nlearner.a@academiapath.example,student'}
            />
            <p id="import-csv-hint" className="mt-1 text-xs text-slate-500">
              {t.users.csvHint}
            </p>
          </div>
          {previewAction.result ? <Alert tone={previewAction.result.tone}>{previewAction.result.message}</Alert> : null}
          <div className="flex justify-end">
            <Button type="submit" variant="secondary" disabled={previewAction.pending || !courseId || !csv.trim()}>
              {previewAction.pending ? t.users.previewing : t.users.preview}
            </Button>
          </div>
        </form>
      </Card>

      {report && summary ? (
        <Card as="section" aria-labelledby="import-report-heading" className="space-y-4">
          <h2 id="import-report-heading" className="text-lg font-semibold text-brand-600" aria-live="polite">
            {t.users.previewSummary(summary.create, summary.unchanged, summary.errors)}
          </h2>
          {stale ? <Alert tone="info">{t.users.previewStale}</Alert> : null}
          {!report.result.applied && summary.errors > 0 ? <Alert tone="error">{t.users.fixErrors}</Alert> : null}
          {!report.result.applied && summary.errors === 0 && summary.create === 0 ? <Alert tone="info">{t.users.nothingToApply}</Alert> : null}
          <div className={tableClasses.wrapper}>
            <table className={tableClasses.table}>
              <thead className={tableClasses.head}>
                <tr>
                  <th scope="col" className={tableClasses.th}>{t.users.line}</th>
                  <th scope="col" className={tableClasses.th}>{t.users.email}</th>
                  <th scope="col" className={tableClasses.th}>{t.users.outcome}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {report.result.rows.map((row) => (
                  <tr key={row.line} className={tableClasses.row}>
                    <td className={tableClasses.td}>{row.line}</td>
                    <td className={`${tableClasses.td} break-all`}>{row.email || '—'}</td>
                    <td className={tableClasses.td}>
                      <Badge tone={row.outcome === 'error' ? 'warning' : row.outcome === 'create' ? 'success' : 'neutral'}>{outcomeLabel(row.outcome)}</Badge>
                      {row.errorCode ? <div className="mt-1 text-sm text-red-700">{t.users.importErrors[row.errorCode] ?? row.errorCode}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {applyAction.result ? <Alert tone={applyAction.result.tone}>{applyAction.result.message}</Alert> : null}
          <div className="flex justify-end">
            <Button disabled={!canApply || applyAction.pending} onClick={() => void apply()}>
              {applyAction.pending ? t.users.applying : t.users.apply}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
