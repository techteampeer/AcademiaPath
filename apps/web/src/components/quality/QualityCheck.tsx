'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { QualityFinding, QualityReport } from '@/lib/api/types';
import { formatDateTime, type Messages } from '@/lib/i18n/messages';

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; report: QualityReport; version: unknown }
  | { status: 'error'; message: string };

/**
 * AP-029 "Check content quality" for a whole course (course page) or one activity (activity page). Checks run only
 * when asked (never on every change), one at a time; results computed before the content changed are marked as
 * stale. The API decides every rule and permission; this component words the findings in the interface language.
 *
 * `version` is anything whose identity changes when the content changes (the loaded activity, the activity lists).
 * `runSignal` re-runs the check when it changes (for example after a submission was refused as blocked).
 */
export function QualityCheck({
  courseId,
  activityId,
  version,
  runSignal = 0,
}: {
  courseId: string;
  activityId?: string;
  version: unknown;
  runSignal?: number;
}) {
  const { t, locale } = useLocale();
  const q = t.quality;
  const { handleUnauthorized } = useSession();
  const [state, setState] = useState<State>({ status: 'idle' });
  const running = useRef(false);
  const versionRef = useRef(version);
  versionRef.current = version;

  const run = useCallback(async () => {
    if (running.current) return; // one check at a time
    running.current = true;
    setState({ status: 'loading' });
    const checkedVersion = versionRef.current;
    try {
      const report = activityId ? await api.activityQuality(courseId, activityId) : await api.courseQuality(courseId);
      setState({ status: 'ready', report, version: checkedVersion });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setState({ status: 'error', message: `${q.failed} ${describeApiError(error, locale)}` });
    } finally {
      running.current = false;
    }
  }, [activityId, courseId, handleUnauthorized, locale, q.failed]);

  // Links from the course report open an activity at "#quality": its own check runs once on arrival.
  useEffect(() => {
    if (activityId && window.location.hash === '#quality') {
      document.getElementById('quality')?.scrollIntoView({ block: 'start' });
      void run();
    }
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lastSignal = useRef(runSignal);
  useEffect(() => {
    if (runSignal !== lastSignal.current) {
      lastSignal.current = runSignal;
      void run();
    }
  }, [runSignal, run]);

  const loading = state.status === 'loading';
  const stale = state.status === 'ready' && !Object.is(state.version, version);
  const headingId = activityId ? 'quality-activity-heading' : 'quality-course-heading';

  return (
    <Card as="section" id="quality" aria-labelledby={headingId} aria-busy={loading || undefined} className="scroll-mt-24 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-lg font-semibold text-brand-600">
            {q.heading}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">{activityId ? q.activityIntro : q.courseIntro}</p>
        </div>
        <Button variant={state.status === 'ready' && !stale ? 'secondary' : 'primary'} onClick={() => void run()} disabled={loading} data-quality-run="">
          {loading ? q.checking : state.status === 'idle' ? (activityId ? q.runActivity : q.run) : q.rerun}
        </Button>
      </div>

      {loading ? (
        <p role="status" className="text-sm text-slate-600">
          {q.checking}
        </p>
      ) : null}
      {state.status === 'error' ? <Alert tone="error">{state.message}</Alert> : null}
      {state.status === 'ready' ? <Results report={state.report} stale={stale} courseId={courseId} activityScope={Boolean(activityId)} /> : null}
    </Card>
  );
}

function Results({ report, stale, courseId, activityScope }: { report: QualityReport; stale: boolean; courseId: string; activityScope: boolean }) {
  const { t, locale } = useLocale();
  const q = t.quality;
  const blocking = report.findings.filter((finding) => finding.severity === 'blocking');
  const warnings = report.findings.filter((finding) => finding.severity === 'warning');
  const empty = !activityScope && report.summary.activities === 0 && report.summary.sections === 0;

  return (
    <div className="space-y-4" data-quality-report={stale ? 'stale' : 'current'}>
      {stale ? <Alert tone="info">{q.stale}</Alert> : null}
      {report.findings.length === 0 ? (
        <Alert tone={empty ? 'info' : 'success'}>
          <span className="font-medium" data-quality-clear="">
            {empty ? q.nothingToCheck : q.allClear}
          </span>
        </Alert>
      ) : (
        <p role="status" className="font-medium text-slate-900">
          {q.summary(blocking.length, warnings.length)}
        </p>
      )}
      <p className="text-xs text-slate-500">
        {activityScope ? null : `${q.scope(report.summary.sections, report.summary.activities)} · `}
        {q.checkedAt(formatDateTime(report.checkedAt, locale))}
      </p>
      {report.limited ? <Alert tone="info">{q.limited}</Alert> : null}
      {blocking.length ? <FindingGroup kind="blocking" findings={blocking} report={report} courseId={courseId} activityScope={activityScope} /> : null}
      {warnings.length ? <FindingGroup kind="warning" findings={warnings} report={report} courseId={courseId} activityScope={activityScope} /> : null}
    </div>
  );
}

function FindingGroup({
  kind,
  findings,
  report,
  courseId,
  activityScope,
}: {
  kind: 'blocking' | 'warning';
  findings: QualityFinding[];
  report: QualityReport;
  courseId: string;
  activityScope: boolean;
}) {
  const { t, locale } = useLocale();
  const q = t.quality;
  const id = `quality-${kind}-${activityScope ? 'activity' : 'course'}`;
  const sections = new Map(report.sections.map((section) => [section.id, section]));
  const activities = new Map(report.activities.map((activity) => [activity.id, activity]));
  return (
    <div className={`rounded-lg border p-4 ${kind === 'blocking' ? 'border-red-200 bg-red-50/60' : 'border-amber-200 bg-amber-50/50'}`}>
      <h3 id={id} className="font-semibold text-slate-900">
        {kind === 'blocking' ? q.blockingHeading : q.warningsHeading} ({findings.length})
      </h3>
      <p className="mt-0.5 text-sm text-slate-700">{kind === 'blocking' ? q.blockingHelp : q.warningsHelp}</p>
      <ul aria-labelledby={id} className="mt-3 space-y-3">
        {findings.map((finding, index) => {
          const section = finding.sectionId ? sections.get(finding.sectionId) : undefined;
          const activity = finding.activityId ? activities.get(finding.activityId) : undefined;
          return (
            <li
              key={`${finding.code}-${finding.activityId ?? finding.sectionId ?? 'course'}-${finding.itemId ?? ''}-${finding.field ?? ''}-${index}`}
              className="rounded-md border border-slate-200 bg-white p-3 text-sm"
              data-quality-code={finding.code}
            >
              <div className="flex flex-wrap items-start gap-2">
                <Badge tone={kind === 'blocking' ? 'warning' : 'neutral'}>
                  <span className="sr-only">{q.severityLabel}: </span>
                  {q.severity[kind]}
                </Badge>
                <p className="min-w-0 flex-1 font-medium break-words text-slate-900">{describe(finding, q, locale, sections)}</p>
              </div>
              <p className="mt-1 text-xs break-words text-slate-600">{location(finding, q, activityScope, section?.title, activity?.title)}</p>
              <p className="mt-2 text-slate-700">
                <span className="font-medium">{q.howToFix}: </span>
                {q.issues[finding.code].fix}
              </p>
              {!activityScope && finding.activityId ? (
                <Link href={`/courses/${courseId}/activities/${finding.activityId}#quality`} className="mt-2 inline-block font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800">
                  {q.openActivity}
                  <span className="sr-only">: {activity?.title?.trim() || q.untitled}</span>
                </Link>
              ) : null}
              {!activityScope && finding.target === 'section' && finding.sectionId ? (
                <a href={`#section-${finding.sectionId}`} className="mt-2 inline-block font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800">
                  {q.goToSection}
                  <span className="sr-only">: {section?.title ?? ''}</span>
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type QualityText = Messages['quality'];

/** The finding's description; values are shown as authored, dates in the interface language. */
function describe(finding: QualityFinding, q: QualityText, locale: 'en' | 'es', sections: Map<string, { title: string }>): string {
  let value = finding.value ?? '';
  if (finding.code === 'ASSIGNMENT_DEADLINE_PASSED' && value) value = formatDateTime(value, locale);
  if ((finding.code === 'PREREQUISITE_SECTION_HIDDEN' || finding.code === 'PREREQUISITE_SECTION_EMPTY') && value) value = sections.get(value)?.title ?? q.untitled;
  return q.issues[finding.code].title(value);
}

function location(finding: QualityFinding, q: QualityText, activityScope: boolean, sectionTitle?: string, activityTitle?: string): string {
  const parts: string[] = [];
  if (finding.target === 'course') parts.push(q.courseInformation);
  if (!activityScope && finding.target !== 'course' && sectionTitle !== undefined) parts.push(sectionTitle.trim() || q.untitled);
  if (!activityScope && finding.target === 'activity') parts.push(activityTitle?.trim() || q.untitled);
  if (finding.itemNumber !== null) parts.push(finding.field === 'criterion' ? q.criterion(finding.itemNumber) : q.question(finding.itemNumber));
  if (finding.field && finding.field in q.field) parts.push(q.field[finding.field as keyof QualityText['field']]);
  return parts.join(' › ');
}
