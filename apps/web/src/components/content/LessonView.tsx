'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Activity, ActivityCreate, Course, CurrentUser } from '@/lib/api/types';
import { AssignmentGradingPanel } from '@/components/assignments/AssignmentGradingPanel';
import { AssignmentStudentPanel } from '@/components/assignments/AssignmentStudentPanel';
import { AssignmentSummary } from '@/components/assignments/assignmentDisplay';
import { QuizSummary } from '@/components/quizzes/quizDisplay';
import { QuizQuestionsPanel, QuizResultsPanel } from '@/components/quizzes/QuizStaffPanels';
import { QuizStudentPanel } from '@/components/quizzes/QuizStudentPanel';
import { DocumentPanel } from '@/components/documents/DocumentPanel';
import { ActivityForm } from './ActivityForm';
import { ACTIVITY_TYPE_LABELS, contentAbilities, ReviewStatusBadge, safeHttpUrl, type ContentAbilities } from './contentDisplay';

type ViewState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error' }
  | { status: 'ready'; course: Course; activity: Activity };

export function LessonView({ courseId, activityId }: { courseId: string; activityId: string }) {
  return <RequireAuth>{(user) => <LessonContent courseId={courseId} activityId={activityId} user={user} />}</RequireAuth>;
}

/** Renders lesson text, a link or quiz settings. Text is always rendered as text (React escapes it), never as HTML. */
function ContentBody({ activity }: { activity: Activity }) {
  const content = activity.content;
  if ('attemptLimit' in content) return <QuizSummary content={content} />;
  if ('rubric' in content) return <AssignmentSummary content={content} />;
  // Documents are rendered by DocumentPanel.
  if ('documentId' in content) return null;
  if ('body' in content) {
    return <div className="whitespace-pre-wrap break-words text-slate-800">{content.body}</div>;
  }
  const href = safeHttpUrl(content.url);
  return (
    <div className="space-y-3">
      {content.description ? <p className="text-slate-700">{content.description}</p> : null}
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className={buttonClasses({ variant: 'secondary' })}>
          Open resource
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : null}
      <p className="break-all text-xs text-slate-500">{content.url}</p>
    </div>
  );
}

function LessonContent({ courseId, activityId, user }: { courseId: string; activityId: string; user: CurrentUser }) {
  const { handleUnauthorized } = useSession();
  const [state, setState] = useState<ViewState>({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      const [course, activity] = await Promise.all([api.getCourse(courseId), api.getActivity(courseId, activityId)]);
      setState({ status: 'ready', course, activity });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      // 404 covers missing content and content this user may not see (unapproved, hidden, other courses).
      else if (isApiError(error, 404) || isApiError(error, 400)) setState({ status: 'not-found' });
      else setState({ status: 'error' });
    }
  }, [courseId, activityId, handleUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const backLink = (
    <Link href={`/courses/${courseId}`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
      Back to course
    </Link>
  );

  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        Loading lesson…
      </p>
    );
  }
  if (state.status === 'not-found') {
    return <EmptyState titleAs="h1" title="Content not available" description="This content does not exist or is not available to you." action={backLink} />;
  }
  if (state.status === 'error') {
    return (
      <Alert tone="error">
        The lesson could not be loaded.{' '}
        <button type="button" className="font-medium underline" onClick={() => void load()}>
          Try again
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
        {backLink}
        <p className="mt-4 text-sm text-slate-500">
          {course.code} · {ACTIVITY_TYPE_LABELS[activity.type]}
        </p>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight break-words text-slate-900 sm:text-3xl">{activity.title}</h1>
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
        />
      ) : null}

      {activity.type === 'file' ? (
        <DocumentPanel
          courseId={courseId}
          activity={activity}
          canRefresh={abilities.edit && activity.review !== null && activity.review.status !== 'submitted'}
          onChanged={() => void load()}
        />
      ) : (
        <Card as="article" padding="lg" aria-label={isQuiz ? 'Quiz details' : 'Lesson content'}>
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
      {isQuiz && abilities.viewResults ? <QuizResultsPanel courseId={courseId} quizId={activity.id} canRelease={abilities.grade} /> : null}
      {isQuiz && abilities.attempt ? <QuizStudentPanel courseId={courseId} quizId={activity.id} /> : null}
      {activity.type === 'assignment' && abilities.viewGrades ? (
        <AssignmentGradingPanel courseId={courseId} assignmentId={activity.id} canGrade={abilities.grade} />
      ) : null}
      {activity.type === 'assignment' && abilities.attempt ? <AssignmentStudentPanel courseId={courseId} assignmentId={activity.id} /> : null}
    </div>
  );
}

/** Review status, comments and actions for course staff. The API enforces every action. */
function StaffPanel({
  courseId,
  activity,
  user,
  abilities,
  onChanged,
}: {
  courseId: string;
  activity: Activity;
  user: CurrentUser;
  abilities: ContentAbilities;
  onChanged: (activity: Activity) => void;
}) {
  const review = activity.review!;
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
      (saved) => (saved.liveVersion ? 'Revision saved. Students keep seeing the approved version until this revision is approved.' : 'Changes saved.'),
    );
    if (updated) {
      setEditing(false);
      onChanged(updated);
    }
    return updated !== null;
  };

  const submit = async () => {
    const updated = await run((csrf) => api.submitActivity(courseId, activity.id, csrf), () => 'Submitted for review.');
    if (updated) onChanged(updated);
  };

  const decide = async (decision: 'approve' | 'return') => {
    const trimmed = comment.trim();
    if (decision === 'return' && !trimmed) {
      setCommentError('Explain what needs to change before returning the content.');
      return;
    }
    setCommentError(null);
    const updated = await run(
      (csrf) => api.reviewActivity(courseId, activity.id, { decision, ...(trimmed ? { comment: trimmed } : {}) }, csrf),
      () => (decision === 'approve' ? 'Approved. Students can now read this content.' : 'Returned to the author with your comment.'),
    );
    if (updated) {
      setComment('');
      onChanged(updated);
    }
  };

  return (
    <Card as="section" aria-labelledby="review-heading" className="space-y-4">
      <h2 id="review-heading" className="text-lg font-semibold text-slate-900">
        Review
      </h2>
      {status === 'returned' && review.comment ? <Alert tone="error">Returned for changes: {review.comment}</Alert> : null}
      {status !== 'returned' && review.comment ? <Alert tone="info">Reviewer comment: {review.comment}</Alert> : null}
      {activity.liveVersion && status !== 'approved' ? (
        <Alert tone="info">
          Students currently see the approved version &ldquo;{activity.liveVersion.title}&rdquo;. This revision is not visible to them until it is
          approved.
        </Alert>
      ) : null}
      {!activity.liveVersion ? <p className="text-sm text-slate-600">Not visible to students until approved.</p> : null}
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}

      {editing ? (
        <ActivityForm
          idPrefix="edit"
          initial={activity}
          fixedType={activity.type}
          submitLabel={status === 'approved' ? 'Save as new revision' : 'Save changes'}
          pending={pending}
          onSubmit={save}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="flex flex-wrap gap-3">
          {canEdit ? (
            <Button variant="secondary" onClick={() => setEditing(true)} disabled={pending}>
              Edit
            </Button>
          ) : null}
          {canSubmit ? (
            <Button onClick={() => void submit()} disabled={pending}>
              Submit for review
            </Button>
          ) : null}
        </div>
      )}

      {canReview ? (
        <div className="space-y-3 border-t border-slate-200 pt-4">
          <h3 className="font-semibold text-slate-900">Review decision</h3>
          {ownSubmission ? (
            <p className="text-sm text-slate-600">You submitted this content, so another reviewer must approve it. You can still return it.</p>
          ) : null}
          <div>
            <label htmlFor="review-comment" className="block text-sm font-medium text-slate-800">
              Comment (required to return)
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
              Approve
            </Button>
            <Button variant="secondary" onClick={() => void decide('return')} disabled={pending}>
              Return with comments
            </Button>
          </div>
        </div>
      ) : null}
      {status === 'submitted' && !abilities.review ? <Badge tone="brand">Waiting for the design team&rsquo;s review</Badge> : null}
    </Card>
  );
}
