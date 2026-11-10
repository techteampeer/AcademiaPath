'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { contentAbilities } from '@/components/content/contentDisplay';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { lessonHref, SectionActivities } from '@/components/content/SectionActivities';
import { DocumentLibrary } from '@/components/documents/DocumentLibrary';
import { LockedNotice, ProgressBar } from '@/components/progress/ProgressDisplay';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Breadcrumbs } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Activity, ActivityProgress, Course, CourseProgress, CurrentUser, ResourceFolder, Section } from '@/lib/api/types';
import { LocalizedCourseStatusBadge as CourseStatusBadge } from '@/components/courses/LocalizedCourseStatusBadge';

/** Upper bound on pages fetched per list (100 items per page). */
const MAX_PAGES = 10;

type ActivitiesBySection = Record<string, Activity[]>;
type FoldersBySection = Record<string, ResourceFolder[]>;
type CompletionByActivity = Record<string, ActivityProgress>;
/** A student's progress (from the API) and the completion state of each activity in open sections. */
type StudentProgress = { course: CourseProgress; completion: CompletionByActivity };

type DetailState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error' }
  | { status: 'ready'; course: Course; sections: Section[]; activities: ActivitiesBySection; folders: FoldersBySection; progress: StudentProgress | null };

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

/**
 * Activities per section. Sections locked by a prerequisite are not requested (the API would answer
 * 403 SECTION_LOCKED without content); a section that locks in the meantime simply shows no activities.
 */
async function loadActivities(courseId: string, sections: Section[], locked: ReadonlySet<string> = new Set()): Promise<ActivitiesBySection> {
  const lists = await Promise.all(
    sections.map((section) =>
      locked.has(section.id)
        ? Promise.resolve([] as Activity[])
        : loadAll((cursor) => api.listActivities(courseId, section.id, { limit: 100, cursor })).catch((error: unknown) => {
            if (isApiError(error, 403) && error.code === 'SECTION_LOCKED') return [] as Activity[];
            throw error;
          }),
    ),
  );
  return Object.fromEntries(sections.map((section, index) => [section.id, lists[index] ?? []]));
}

/** Resource folders per section (students only receive folders holding visible content; locked sections are skipped). */
async function loadFolders(courseId: string, sections: Section[], locked: ReadonlySet<string> = new Set()): Promise<FoldersBySection> {
  const lists = await Promise.all(
    sections.map((section) =>
      locked.has(section.id)
        ? Promise.resolve([] as ResourceFolder[])
        : api
            .listResourceFolders(courseId, section.id)
            .then((list) => list.items)
            .catch((error: unknown) => {
              if (isApiError(error, 403) && error.code === 'SECTION_LOCKED') return [] as ResourceFolder[];
              throw error;
            }),
    ),
  );
  return Object.fromEntries(sections.map((section, index) => [section.id, lists[index] ?? []]));
}

/** The student's progress and per-activity completion for every open section (all calculated by the API). */
async function loadStudentProgress(courseId: string): Promise<StudentProgress> {
  const course = await api.courseProgress(courseId);
  const open = course.sections.filter((section) => !section.locked);
  const details = await Promise.all(open.map((section) => api.sectionProgress(courseId, section.sectionId)));
  const completion: CompletionByActivity = {};
  for (const detail of details) for (const activity of detail.activities) completion[activity.activityId] = activity;
  return { course, completion };
}

const lockedIn = (progress: StudentProgress | null) => new Set(progress?.course.sections.filter((s) => s.locked).map((s) => s.sectionId) ?? []);

export function CourseDetail({ courseId }: { courseId: string }) {
  return <RequireAuth>{(user) => <CourseDetailContent courseId={courseId} user={user} />}</RequireAuth>;
}

function CourseDetailContent({ courseId, user }: { courseId: string; user: CurrentUser }) {
  const { handleUnauthorized } = useSession();
  const { t } = useLocale();
  const [state, setState] = useState<DetailState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const course = await api.getCourse(courseId);
      const sections = await loadAll((cursor) => api.listSections(courseId, { limit: 100, cursor }));
      const progress = course.viewerRole === 'student' ? await loadStudentProgress(courseId) : null;
      const [activities, folders] = await Promise.all([loadActivities(courseId, sections, lockedIn(progress)), loadFolders(courseId, sections, lockedIn(progress))]);
      setState({ status: 'ready', course, sections, activities, folders, progress });
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
      // Completing work can open sections, so progress is reloaded before the activity lists.
      const progress = state.progress ? await loadStudentProgress(courseId) : null;
      const [activities, folders] = await Promise.all([loadActivities(courseId, state.sections, lockedIn(progress)), loadFolders(courseId, state.sections, lockedIn(progress))]);
      setState({ ...state, activities, folders, progress });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
    }
  }, [courseId, state, handleUnauthorized]);

  const backLink = (
    <Link href="/dashboard" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
      {t.courses.backToDashboard}
    </Link>
  );

  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {t.courses.loadingCourse}
      </p>
    );
  }
  if (state.status === 'not-found') {
    return <EmptyState titleAs="h1" title={t.courses.notAvailableTitle} description={t.courses.notAvailableDescription} action={backLink} />;
  }
  if (state.status === 'error') {
    return (
      <Alert tone="error">
        {t.courses.loadErrorCourse}{' '}
        <button type="button" className="font-medium underline" onClick={() => void load()}>
          {t.common.retry}
        </button>
      </Alert>
    );
  }

  const { course, sections, activities, folders, progress } = state;
  const sectionProgress = new Map(progress?.course.sections.map((section) => [section.sectionId, section]) ?? []);
  const continueAt = progress?.course.continueAt ?? null;
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
        <Breadcrumbs label={t.common.breadcrumb} items={[{ label: t.nav.myCourses, href: '/courses' }, { label: course.title }]} />
        <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight break-words text-slate-900 sm:text-3xl">{course.title}</h1>
          <CourseStatusBadge status={course.status} />
        </div>
        <p className="mt-1 text-sm text-slate-500">
          {course.code}
          {course.viewerRole ? ` · ${t.courses.yourRoleLabel(t.roles[course.viewerRole])}` : ''}
        </p>
        {course.description ? <p className="mt-3 max-w-3xl text-slate-600">{course.description}</p> : null}
        <div className="mt-4 flex flex-wrap gap-3">
          {abilities.viewGrades || abilities.attempt ? (
            <Link href={`/courses/${course.id}/grades`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
              {abilities.viewGrades ? t.nav.gradebook : t.nav.myGrades}
            </Link>
          ) : null}
          {abilities.tutor ? (
            <Link href={`/courses/${course.id}/tutor`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
              {t.nav.tutor}
            </Link>
          ) : null}
          {abilities.viewProgress ? (
            <Link href={`/courses/${course.id}/progress`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
              {t.progress.studentProgress}
            </Link>
          ) : null}
        </div>
      </div>

      {progress ? (
        <Card as="section" aria-labelledby="my-progress-heading" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="my-progress-heading" className="text-lg font-semibold text-slate-900">
              {t.progress.yourProgress}
            </h2>
            {continueAt ? (
              <Link href={lessonHref(course.id, continueAt.activityId)} className={buttonClasses({ size: 'sm' })}>
                {t.progress.continueLearning}
                <span className="sr-only">: {continueAt.title}</span>
              </Link>
            ) : null}
          </div>
          <ProgressBar figures={progress.course} label={t.progress.progressOf(course.title)} />
          {continueAt ? <p className="text-sm text-slate-600">{t.progress.continueWith(continueAt.title)}</p> : null}
          <p className="text-xs text-slate-500">{t.progress.separateFromGrades}</p>
        </Card>
      ) : null}

      {abilities.review ? (
        <Card as="section" aria-labelledby="review-queue-heading">
          <h2 id="review-queue-heading" className="text-lg font-semibold text-slate-900">
            {t.courses.waitingForReview}
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
            <p className="mt-2 text-sm text-slate-600">{t.courses.nothingWaiting}</p>
          )}
        </Card>
      ) : null}

      <DocumentLibrary courseId={course.id} sections={sections} activities={activities} abilities={abilities} onUploaded={refreshActivities} />

      <section aria-labelledby="sections-heading">
        <h2 id="sections-heading" className="text-xl font-semibold tracking-tight text-slate-900">
          {t.courses.sections}
        </h2>
        {sections.length === 0 ? (
          <EmptyState className="mt-4" title={t.courses.noSections} description={t.courses.noSectionsDescription} />
        ) : (
          <ol className="mt-4 space-y-3">
            {sections.map((section, index) => {
              const mine = sectionProgress.get(section.id);
              return (
                <Card as="li" key={section.id} data-section-locked={mine?.locked ? 'true' : undefined}>
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-semibold text-slate-900">
                      <span className="mr-2 text-slate-400">{index + 1}.</span>
                      {section.title}
                    </h3>
                    <div className="flex flex-wrap justify-end gap-2">
                      {section.isVisible ? null : <Badge tone="warning">{t.courses.hiddenFromStudents}</Badge>}
                      {mine?.locked ? <Badge tone="warning">🔒 {t.progress.locked}</Badge> : null}
                      {mine && !mine.locked && mine.state === 'completed' ? <Badge tone="success">✓ {t.progress.completed}</Badge> : null}
                    </div>
                  </div>
                  {section.summary ? <p className="mt-2 text-sm text-slate-600">{section.summary}</p> : null}
                  {mine && mine.percent !== null ? (
                    <div className="mt-3">
                      <ProgressBar figures={mine} label={t.progress.progressOf(section.title)} compact />
                    </div>
                  ) : null}
                  {mine?.locked ? (
                    <LockedNotice requiredSections={mine.requiredSections} />
                  ) : (
                    <SectionActivities
                      courseId={course.id}
                      sectionId={section.id}
                      sectionTitle={section.title}
                      items={activities[section.id] ?? []}
                      folders={folders[section.id] ?? []}
                      abilities={abilities}
                      completion={progress?.completion}
                      onChanged={refreshActivities}
                    />
                  )}
                </Card>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
