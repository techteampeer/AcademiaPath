'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { formatGrade20, GradeStatusBadge, ReleasedGradeView } from '@/components/assignments/assignmentDisplay';
import { contentAbilities } from '@/components/content/contentDisplay';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Course, CurrentUser, Gradebook, StudentGrades } from '@/lib/api/types';
import { ReleaseGradesButton } from './ReleaseGradesButton';

type Load<T> = { status: 'loading' } | { status: 'not-found' } | { status: 'error'; message: string } | { status: 'ready'; data: T };

export function GradesView({ courseId }: { courseId: string }) {
  return <RequireAuth>{(user) => <GradesContent courseId={courseId} user={user} />}</RequireAuth>;
}

function GradesContent({ courseId, user }: { courseId: string; user: CurrentUser }) {
  const { handleUnauthorized } = useSession();
  const [course, setCourse] = useState<Load<Course>>({ status: 'loading' });

  useEffect(() => {
    api
      .getCourse(courseId)
      .then((data) => setCourse({ status: 'ready', data }))
      .catch((error: unknown) => {
        if (isApiError(error, 401)) handleUnauthorized();
        else if (isApiError(error, 404) || isApiError(error, 400)) setCourse({ status: 'not-found' });
        else setCourse({ status: 'error', message: describeApiError(error) });
      });
  }, [courseId, handleUnauthorized]);

  const backLink = (
    <Link href={`/courses/${courseId}`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
      Back to course
    </Link>
  );
  if (course.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        Loading grades…
      </p>
    );
  }
  if (course.status === 'not-found') {
    return <EmptyState titleAs="h1" title="Course not available" description="This course does not exist or is not available to you." action={backLink} />;
  }
  if (course.status === 'error') return <Alert tone="error">{course.message}</Alert>;

  const abilities = contentAbilities(user, course.data.viewerRole);
  return (
    <div className="space-y-6">
      <div>
        {backLink}
        <p className="mt-4 text-sm text-slate-500">{course.data.code}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
          {abilities.viewGrades ? 'Gradebook' : 'My grades'}
        </h1>
        <p className="mt-1 text-sm text-slate-600">Scale 0–20, rounded half up to one decimal. All grades are calculated by the server.</p>
      </div>
      {abilities.viewGrades ? (
        <StaffGradebook courseId={courseId} canRelease={abilities.grade} />
      ) : abilities.attempt ? (
        <StudentGradesList courseId={courseId} />
      ) : (
        <Alert tone="info">Grades are available to students and to the course&rsquo;s instructors.</Alert>
      )}
    </div>
  );
}

function useLoad<T>(fetcher: () => Promise<T>) {
  const { handleUnauthorized } = useSession();
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', data: await fetcher() });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setState({ status: 'error', message: describeApiError(error) });
    }
  }, [fetcher, handleUnauthorized]);
  useEffect(() => {
    void load();
  }, [load]);
  return { state, load };
}

/** Instructor view: one row per student, one column per approved quiz or assignment. */
function StaffGradebook({ courseId, canRelease }: { courseId: string; canRelease: boolean }) {
  const fetcher = useCallback(() => api.getGradebook(courseId, { limit: 100 }), [courseId]);
  const { state, load } = useLoad<Gradebook>(fetcher);
  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        Loading gradebook…
      </p>
    );
  }
  if (state.status !== 'ready') return <Alert tone="error">{state.status === 'error' ? state.message : 'Not available.'}</Alert>;
  const book = state.data;
  if (!book.columns.length) return <EmptyState title="Nothing to grade yet" description="Approved quizzes and assignments appear here." />;
  return (
    <Card as="section" aria-label="Gradebook" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          Quizzes count each student&rsquo;s best attempt. Totals sum points over graded items and convert them to 0–20.
        </p>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 align-bottom text-slate-500">
            <tr>
              <th scope="col" className="py-2 pr-4 font-medium">Student</th>
              {book.columns.map((column) => (
                <th key={column.activityId} scope="col" className="min-w-40 py-2 pr-4 font-medium">
                  <Link href={`/courses/${courseId}/activities/${column.activityId}`} className="text-brand-700 hover:underline">
                    {column.title}
                  </Link>
                  <span className="block text-xs font-normal">
                    {column.type === 'quiz' ? 'Quiz' : 'Assignment'} · {column.maxPoints} pts
                  </span>
                  {canRelease ? (
                    <div className="mt-2 font-normal">
                      <ReleaseGradesButton courseId={courseId} activityId={column.activityId} label="Release" onReleased={() => void load()} />
                    </div>
                  ) : null}
                </th>
              ))}
              <th scope="col" className="py-2 font-medium">Course total</th>
            </tr>
          </thead>
          <tbody>
            {book.items.map((row) => (
              <tr key={row.student.id} className="border-b border-slate-100 align-top">
                <th scope="row" className="py-2 pr-4 font-normal">
                  <span className="block text-slate-900">
                    {row.student.givenName} {row.student.familyName}
                  </span>
                  <span className="block text-xs break-all text-slate-500">{row.student.email}</span>
                </th>
                {row.cells.map((cell) => (
                  <td key={cell.activityId} className="py-2 pr-4">
                    {cell.points !== null ? (
                      <span className="block font-medium text-slate-900">
                        {formatGrade20(cell.grade20)}
                        <span className="block text-xs font-normal text-slate-500">
                          {cell.points} / {cell.maxPoints} pts
                        </span>
                      </span>
                    ) : null}
                    <GradeStatusBadge status={cell.status} />
                  </td>
                ))}
                <td className="py-2 font-semibold text-slate-900">
                  {formatGrade20(row.total.grade20)}
                  <span className="block text-xs font-normal text-slate-500">
                    {row.total.points} / {row.total.maxPoints} pts · {row.total.gradedItems} graded
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {book.items.length === 0 ? <p className="text-sm text-slate-600">No students are enrolled.</p> : null}
    </Card>
  );
}

/** Student view: only released grades; everything else is pending, without numbers. */
function StudentGradesList({ courseId }: { courseId: string }) {
  const fetcher = useCallback(() => api.myGrades(courseId), [courseId]);
  const { state } = useLoad<StudentGrades>(fetcher);
  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        Loading your grades…
      </p>
    );
  }
  if (state.status !== 'ready') return <Alert tone="error">{state.status === 'error' ? state.message : 'Not available.'}</Alert>;
  const grades = state.data;
  return (
    <div className="space-y-4">
      <Card as="section" aria-labelledby="total-heading">
        <h2 id="total-heading" className="text-sm font-medium text-slate-500">
          Course total (released grades)
        </h2>
        <p className="mt-1 text-2xl font-bold text-slate-900">{formatGrade20(grades.total.grade20)}</p>
        <p className="text-xs text-slate-500">
          {grades.total.points} / {grades.total.maxPoints} points from {grades.total.gradedItems} released {grades.total.gradedItems === 1 ? 'item' : 'items'}
        </p>
      </Card>
      {grades.items.length === 0 ? (
        <p className="text-sm text-slate-600">No graded activities yet.</p>
      ) : (
        <ul className="space-y-3">
          {grades.items.map((item) => (
            <li key={item.activityId}>
              <Card as="article" aria-labelledby={`grade-${item.activityId}`} className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id={`grade-${item.activityId}`} className="font-semibold text-slate-900">
                    <Link href={`/courses/${courseId}/activities/${item.activityId}`} className="text-brand-700 hover:underline">
                      {item.title}
                    </Link>
                    <span className="ml-2 text-xs font-normal text-slate-500">{item.type === 'quiz' ? 'Quiz' : 'Assignment'}</span>
                  </h2>
                  <Badge tone={item.grade ? 'success' : 'neutral'}>{item.grade ? 'Released' : 'Pending'}</Badge>
                </div>
                {item.grade ? <ReleasedGradeView grade={item.grade} /> : <p className="text-sm text-slate-600">Not released yet.</p>}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
