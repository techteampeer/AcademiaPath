'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { contentAbilities } from '@/components/content/contentDisplay';
import { lessonHref, SectionActivities } from '@/components/content/SectionActivities';
import { DocumentLibrary } from '@/components/documents/DocumentLibrary';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Activity, Course, CurrentUser, Section } from '@/lib/api/types';
import { CourseStatusBadge } from './CourseCard';
import { COURSE_ROLE_LABELS } from './courseDisplay';

/** Upper bound on pages fetched per list (100 items per page). */
const MAX_PAGES = 10;

type ActivitiesBySection = Record<string, Activity[]>;

type DetailState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error' }
  | { status: 'ready'; course: Course; sections: Section[]; activities: ActivitiesBySection };

async function loadAll<T>(fetchPage: (cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null }>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(cursor);
    items.push(...result.items);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return items;
}

async function loadActivities(courseId: string, sections: Section[]): Promise<ActivitiesBySection> {
  const lists = await Promise.all(
    sections.map((section) => loadAll((cursor) => api.listActivities(courseId, section.id, { limit: 100, cursor }))),
  );
  return Object.fromEntries(sections.map((section, index) => [section.id, lists[index] ?? []]));
}

export function CourseDetail({ courseId }: { courseId: string }) {
  return <RequireAuth>{(user) => <CourseDetailContent courseId={courseId} user={user} />}</RequireAuth>;
}

function CourseDetailContent({ courseId, user }: { courseId: string; user: CurrentUser }) {
  const { handleUnauthorized } = useSession();
  const [state, setState] = useState<DetailState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const course = await api.getCourse(courseId);
      const sections = await loadAll((cursor) => api.listSections(courseId, { limit: 100, cursor }));
      const activities = await loadActivities(courseId, sections);
      setState({ status: 'ready', course, sections, activities });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      // The API answers 404 both for missing courses and for courses this user may not access.
      else if (isApiError(error, 404) || isApiError(error, 400)) setState({ status: 'not-found' });
      else setState({ status: 'error' });
    }
  }, [courseId, handleUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshActivities = useCallback(async () => {
    if (state.status !== 'ready') return;
    try {
      const activities = await loadActivities(courseId, state.sections);
      setState({ ...state, activities });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
    }
  }, [courseId, state, handleUnauthorized]);

  const backLink = (
    <Link href="/dashboard" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
      Back to dashboard
    </Link>
  );

  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        Loading course…
      </p>
    );
  }
  if (state.status === 'not-found') {
    return (
      <EmptyState
        titleAs="h1"
        title="Course not available"
        description="This course does not exist or you do not have access to it."
        action={backLink}
      />
    );
  }
  if (state.status === 'error') {
    return (
      <Alert tone="error">
        The course could not be loaded.{' '}
        <button type="button" className="font-medium underline" onClick={() => void load()}>
          Try again
        </button>
      </Alert>
    );
  }

  const { course, sections, activities } = state;
  const abilities = contentAbilities(user, course.viewerRole);
  const waitingForReview = abilities.review
    ? sections.flatMap((section) =>
        (activities[section.id] ?? [])
          .filter((activity) => activity.review?.status === 'submitted')
          .map((activity) => ({ activity, section })),
      )
    : [];

  return (
    <div className="space-y-8">
      <div>
        {backLink}
        <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{course.title}</h1>
          <CourseStatusBadge status={course.status} />
        </div>
        <p className="mt-1 text-sm text-slate-500">
          {course.code}
          {course.viewerRole ? ` · Your role: ${COURSE_ROLE_LABELS[course.viewerRole]}` : ''}
        </p>
        {course.description ? <p className="mt-3 max-w-3xl text-slate-600">{course.description}</p> : null}
        <div className="mt-4 flex flex-wrap gap-3">
          {abilities.viewGrades || abilities.attempt ? (
            <Link href={`/courses/${course.id}/grades`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
              {abilities.viewGrades ? 'Gradebook' : 'My grades'}
            </Link>
          ) : null}
          {abilities.tutor ? (
            <Link href={`/courses/${course.id}/tutor`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
              Tutor
            </Link>
          ) : null}
        </div>
      </div>

      {abilities.review ? (
        <Card as="section" aria-labelledby="review-queue-heading">
          <h2 id="review-queue-heading" className="text-lg font-semibold text-slate-900">
            Waiting for review
          </h2>
          {waitingForReview.length ? (
            <ul className="mt-3 space-y-2">
              {waitingForReview.map(({ activity, section }) => (
                <li key={activity.id} className="text-sm">
                  <Link href={lessonHref(course.id, activity.id)} className="font-medium text-brand-700 hover:underline">
                    {activity.title}
                  </Link>
                  <span className="text-slate-500"> · {section.title}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-600">Nothing is waiting for review.</p>
          )}
        </Card>
      ) : null}

      <DocumentLibrary courseId={course.id} sections={sections} activities={activities} abilities={abilities} onUploaded={refreshActivities} />

      <section aria-labelledby="sections-heading">
        <h2 id="sections-heading" className="text-xl font-semibold tracking-tight text-slate-900">
          Sections
        </h2>
        {sections.length === 0 ? (
          <EmptyState className="mt-4" title="No sections yet" description="This course has no sections you can view." />
        ) : (
          <ol className="mt-4 space-y-3">
            {sections.map((section, index) => (
              <Card as="li" key={section.id}>
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-semibold text-slate-900">
                    <span className="mr-2 text-slate-400">{index + 1}.</span>
                    {section.title}
                  </h3>
                  {section.isVisible ? null : <Badge tone="warning">Hidden from students</Badge>}
                </div>
                {section.summary ? <p className="mt-2 text-sm text-slate-600">{section.summary}</p> : null}
                <SectionActivities
                  courseId={course.id}
                  sectionId={section.id}
                  sectionTitle={section.title}
                  items={activities[section.id] ?? []}
                  abilities={abilities}
                  onChanged={refreshActivities}
                />
              </Card>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
