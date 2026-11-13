'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Breadcrumbs } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Activity, ActivityCreate, ActivityProgress, Course, CurrentUser } from '@/lib/api/types';
import { AssignmentGradingPanel } from '@/components/assignments/AssignmentGradingPanel';
import { AssignmentStudentPanel } from '@/components/assignments/AssignmentStudentPanel';
import { AssignmentSummary } from '@/components/assignments/assignmentDisplay';
import { QuizSummary } from '@/components/quizzes/quizDisplay';
import { QuizQuestionsPanel, QuizResultsPanel } from '@/components/quizzes/QuizStaffPanels';
import { QuizStudentPanel } from '@/components/quizzes/QuizStudentPanel';
import { DocumentPanel } from '@/components/documents/DocumentPanel';
import { CompletionControl } from '@/components/progress/ProgressDisplay';
import { QualityCheck } from '@/components/quality/QualityCheck';
import { ActivityForm } from './ActivityForm';
import { contentAbilities, ReviewStatusBadge, safeHttpUrl, type ContentAbilities } from './contentDisplay';

type ViewState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'locked' }
  | { status: 'error' }
  | { status: 'ready'; course: Course; activity: Activity };

export function LessonView({ courseId, activityId }: { courseId: string; activityId: string }) {
  return <RequireAuth>{(user) => <LessonContent courseId={courseId} activityId={activityId} user={user} />}</RequireAuth>;
}

/** Renders lesson text, a link or quiz settings. Text is always rendered as text (React escapes it), never as HTML. */
function ContentBody({ activity }: { activity: Activity }) {
  const { t } = useLocale();
  const content = activity.content;
  if ('attemptLimit' in content) return <QuizSummary content={content} />;
  if ('rubric' in content) return <AssignmentSummary content={content} />;
  // Documents are rendered by DocumentPanel.
  if ('documentId' in content) return null;
  if ('body' in content) {
    return <div className="whitespace-pre-wrap break-words text-slate-800">{content.body}</div>;
  }
  const href = safeHttpUrl(content.url);
  const kind = content.kind ?? 'website';
  return (
    <div className="space-y-3">
      <Badge tone={kind === 'website' ? 'neutral' : 'brand'}>{t.resources.kindBadge[kind]}</Badge>
      {content.description ? <p className="text-slate-700">{content.description}</p> : null}
      {href ? (
        // Videos and interactive tools are linked, never embedded: they open on their own site in a new tab.
        <a href={href} target="_blank" rel="noopener noreferrer" className={buttonClasses({ variant: 'secondary' })}>
          {t.resources.open[kind]}
          <span className="sr-only"> {t.content.view.newTab}</span>
        </a>
      ) : null}
      <p className="break-all text-xs text-slate-500">{content.url}</p>
    </div>
  );
}

function LessonContent({ courseId, activityId, user }: { courseId: string; activityId: string; user: CurrentUser }) {
  const { handleUnauthorized } = useSession();
  const { t } = useLocale();
  const v = t.content.view;
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  // AP-029: incremented when the API refuses a submission or approval for blocking quality findings.
  const [qualitySignal, setQualitySignal] = useState(0);

  const load = useCallback(async () => {
    try {
      const [course, activity] = await Promise.all([api.getCourse(courseId), api.getActivity(courseId, activityId)]);
      setState({ status: 'ready', course, activity });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      // 404 covers missing content and content this user may not see (unapproved, hidden, other courses).
      else if (isApiError(error, 404) || isApiError(error, 400)) setState({ status: 'not-found' });
      // A section prerequisite still locks this content (enforced by the API; no content is returned).
      else if (isApiError(error, 403) && error.code === 'SECTION_LOCKED') setState({ status: 'locked' });
      else setState({ status: 'error' });
    }
  }, [courseId, activityId, handleUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const backLink = (
    <Link href={`/courses/${courseId}`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
      {v.backToCourse}
    </Link>
  );

  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {v.loading}
      </p>
    );
  }
  if (state.status === 'not-found') {
    return <EmptyState titleAs="h1" title={v.notAvailableTitle} description={v.notAvailableDescription} action={backLink} />;
  }
  if (state.status === 'locked') {
    return <EmptyState titleAs="h1" title={t.progress.lockedTitle} description={t.progress.lockedDescription} action={backLink} />;
  }
  if (state.status === 'error') {
    return (
      <Alert tone="error">
        {v.loadError}{' '}
        <button type="button" className="font-medium underline" onClick={() => void load()}>
          {t.common.retry}
        </button>
      </Alert>
    );
  }

  const { course, activity } = state;
  const abilities = contentAbilities(user, course.viewerRole);
  const isQuiz = activity.type === 'quiz';
  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs
          label={t.common.breadcrumb}
          items={[{ label: t.nav.myCourses, href: '/courses' }, { label: course.title, href: `/courses/${course.id}` }, { label: activity.title }]}
        />
        <p className="mt-4 text-sm text-slate-500">
          {course.code} · {t.activityType[activity.type]}
        </p>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-[1.75rem] leading-tight font-semibold break-words text-brand-600 sm:text-[2.1rem]">{activity.title}</h1>
          {activity.review ? <ReviewStatusBadge status={activity.review.status} /> : null}
        </div>
      </div>

      {activity.review ? (
        <StaffPanel
          courseId={courseId}
          activity={activity}
          user={user}
          abilities={abilities}
          onChanged={(updated) => setState({ status: 'ready', course, activity: updated })}
          onQualityBlocked={() => setQualitySignal((n) => n + 1)}
        />
      ) : null}
      {activity.review && (abilities.edit || abilities.review) ? (
        <QualityCheck courseId={courseId} activityId={activity.id} version={activity} runSignal={qualitySignal} />
      ) : null}

      {activity.type === 'file' ? (
        <DocumentPanel
          courseId={courseId}
          activity={activity}
          canRefresh={abilities.edit && activity.review !== null && activity.review.status !== 'submitted'}
          onChanged={() => void load()}
        />
      ) : (
        <Card as="article" padding="lg" aria-label={isQuiz ? v.quizDetails : v.lessonContent}>
          <ContentBody activity={activity} />
        </Card>
      )}

      {isQuiz && activity.review && abilities.viewUnapproved ? (
        <QuizQuestionsPanel
          courseId={courseId}
          quizId={activity.id}
          canEdit={abilities.edit && activity.review.status !== 'submitted'}
          hasLiveVersion={activity.liveVersion !== null}
          onChanged={() => void load()}
        />
      ) : null}
      {isQuiz && abilities.viewResults ? <QuizResultsPanel courseId={courseId} quizId={activity.id} canRelease={abilities.release} /> : null}
      {isQuiz && abilities.attempt ? <QuizStudentPanel courseId={courseId} quizId={activity.id} /> : null}
      {activity.type === 'assignment' && abilities.viewGrades ? (
        <AssignmentGradingPanel courseId={courseId} assignmentId={activity.id} canGrade={abilities.grade} canRelease={abilities.release} />
      ) : null}
      {activity.type === 'assignment' && abilities.attempt ? <AssignmentStudentPanel courseId={courseId} assignmentId={activity.id} /> : null}
      {abilities.trackProgress ? <LessonCompletion courseId={courseId} activity={activity} /> : null}
    </div>
  );
}

/** The student's completion state for this activity, from the API's section progress. */
function LessonCompletion({ courseId, activity }: { courseId: string; activity: Activity }) {
  const { t } = useLocale();
  const [state, setState] = useState<ActivityProgress | null | 'error'>(null);
  const load = useCallback(async () => {
    try {
      const section = await api.sectionProgress(courseId, activity.sectionId);
      setState(section.activities.find((item) => item.activityId === activity.id) ?? 'error');
    } catch {
      setState('error');
    }
  }, [courseId, activity.id, activity.sectionId]);
  useEffect(() => {
    void load();
  }, [load]);
  if (state === null) return null;
  if (state === 'error') return <p className="text-sm text-slate-500">{t.progress.loadError}</p>;
  return (
    <Card as="section" aria-labelledby="completion-heading" className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 id="completion-heading" className="font-semibold text-brand-600">
          {t.progress.yourProgress}
        </h2>
        <p className="text-xs text-slate-500">{t.progress.separateFromGrades}</p>
      </div>
      <CompletionControl
        courseId={courseId}
        activityId={activity.id}
        title={activity.title}
        completion={state.completion}
        completed={state.completed}
        onChanged={load}
      />
    </Card>
  );
}

/** Review status, comments and actions for course staff. The API enforces every action. */
function StaffPanel({
  courseId,
  activity,
  user,
  abilities,
  onChanged,
  onQualityBlocked,
}: {
  courseId: string;
  activity: Activity;
  user: CurrentUser;
  abilities: ContentAbilities;
  onChanged: (activity: Activity) => void;
  onQualityBlocked: () => void;
}) {
  const review = activity.review!;
  const { t } = useLocale();
  const r = t.content.review;
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState<string | null>(null);
  const { run, pending, result } = useCsrfAction();

  const status = review.status;
  // Documents change through upload and "Refresh summary" (DocumentPanel), not the text editor.
  const canEdit = abilities.edit && status !== 'submitted' && activity.type !== 'file';
  const canSubmit = abilities.edit && (status === 'draft' || status === 'returned');
  const canReview = abilities.review && status === 'submitted';
  const ownSubmission = review.submittedByUserId === user.id;

  const save = async (value: ActivityCreate) => {
    const { type: _type, ...content } = value;
    const updated = await run(
      (csrf) => api.updateActivity(courseId, activity.id, content, csrf),
      (saved) => (saved.liveVersion ? r.revisionSaved : r.changesSaved),
    );
    if (updated) {
      setEditing(false);
      onChanged(updated);
    }
    return updated !== null;
  };

  /** A refusal for blocking quality findings also runs the activity's quality check, so the issues are listed. */
  const showingQualityIssues =
    <T,>(action: (csrf: string) => Promise<T>) =>
    async (csrf: string) => {
      try {
        return await action(csrf);
      } catch (error) {
        if (isApiError(error) && error.code === 'QUALITY_CHECK_BLOCKED') onQualityBlocked();
        throw error;
      }
    };

  const submit = async () => {
    const updated = await run(showingQualityIssues((csrf) => api.submitActivity(courseId, activity.id, csrf)), () => r.submitted);
    if (updated) onChanged(updated);
  };

  const decide = async (decision: 'approve' | 'return') => {
    const trimmed = comment.trim();
    if (decision === 'return' && !trimmed) {
      setCommentError(r.commentRequired);
      return;
    }
    setCommentError(null);
    const updated = await run(
      showingQualityIssues((csrf) => api.reviewActivity(courseId, activity.id, { decision, ...(trimmed ? { comment: trimmed } : {}) }, csrf)),
      () => (decision === 'approve' ? r.approved : r.returned),
    );
    if (updated) {
      setComment('');
      onChanged(updated);
    }
  };

  return (
    <Card as="section" aria-labelledby="review-heading" className="space-y-4">
      <h2 id="review-heading" className="text-lg font-semibold text-brand-600">
        {r.heading}
      </h2>
      {status === 'returned' && review.comment ? <Alert tone="error">{r.returnedFor(review.comment)}</Alert> : null}
      {status !== 'returned' && review.comment ? <Alert tone="info">{r.reviewerComment(review.comment)}</Alert> : null}
      {activity.liveVersion && status !== 'approved' ? <Alert tone="info">{r.liveVersionNote(activity.liveVersion.title)}</Alert> : null}
      {!activity.liveVersion ? <p className="text-sm text-slate-600">{r.notVisible}</p> : null}
      {status === 'approved' ? <p className="text-sm text-slate-600">{r.liveNow}</p> : null}
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}

      {editing ? (
        <ActivityForm
          idPrefix="edit"
          initial={activity}
          fixedType={activity.type}
          submitLabel={status === 'approved' ? r.saveRevision : r.saveChanges}
          pending={pending}
          onSubmit={save}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="flex flex-wrap gap-3">
          {canEdit ? (
            <Button variant="secondary" onClick={() => setEditing(true)} disabled={pending}>
              {r.edit}
            </Button>
          ) : null}
          {canSubmit ? (
            <Button onClick={() => void submit()} disabled={pending}>
              {r.submit}
            </Button>
          ) : null}
        </div>
      )}

      {canReview ? (
        <div className="space-y-3 border-t border-slate-200 pt-4">
          <h3 className="font-semibold text-slate-900">{r.decision}</h3>
          {ownSubmission ? <p className="text-sm text-slate-600">{r.ownSubmission}</p> : null}
          <div>
            <label htmlFor="review-comment" className="block text-sm font-medium text-slate-800">
              {r.comment}
            </label>
            <textarea
              id="review-comment"
              rows={3}
              maxLength={2000}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              aria-invalid={commentError ? true : undefined}
              aria-describedby={commentError ? 'review-comment-error' : undefined}
              className={`mt-1 block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ${commentError ? 'border-red-500' : 'border-slate-300'}`}
            />
            {commentError ? (
              <p id="review-comment-error" className="mt-1 text-sm text-red-700">
                {commentError}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void decide('approve')} disabled={pending || ownSubmission}>
              {r.approve}
            </Button>
            <Button variant="secondary" onClick={() => void decide('return')} disabled={pending}>
              {r.returnWithComments}
            </Button>
          </div>
        </div>
      ) : null}
      {status === 'submitted' && !abilities.review ? <Badge tone="brand">{r.waiting}</Badge> : null}
    </Card>
  );
}
