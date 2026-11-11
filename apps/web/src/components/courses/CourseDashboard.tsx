'use client';

import { useCallback, useEffect, useState } from 'react';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Course, CurrentUser } from '@/lib/api/types';
import { CourseGrid } from './CourseGrid';
import { toCourseSummary } from './courseDisplay';

const PAGE_SIZE = 12;

export function CourseDashboard() {
  return <RequireAuth>{(user) => <DashboardContent user={user} />}</RequireAuth>;
}

function DashboardContent({ user }: { user: CurrentUser }) {
  const { handleUnauthorized } = useSession();
  const [courses, setCourses] = useState<Course[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadingMore, setLoadingMore] = useState(false);

  /** Loads the first page, or the next page when a cursor is given. Read-only, so retrying is safe. */
  const load = useCallback(
    async (cursor?: string) => {
      try {
        const page = await api.listCourses({ limit: PAGE_SIZE, cursor });
        setCourses((previous) => (cursor ? [...previous, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
        setState('ready');
      } catch (error) {
        if (isApiError(error, 401)) handleUnauthorized();
        else setState('error');
      }
    },
    [handleUnauthorized],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const isAdministrator = user.systemRole === 'administrator';

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-[1.75rem] leading-tight font-semibold text-brand-600 sm:text-[2.1rem]">
          {isAdministrator ? 'All courses' : 'My courses'}
        </h1>
        <p className="mt-2 text-slate-600">
          Welcome, {user.givenName}.{' '}
          {isAdministrator ? 'As an administrator you can see every course.' : 'These are the courses you are enrolled in.'}
        </p>
      </div>

      {state === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          Loading courses…
        </p>
      ) : null}

      {state === 'error' ? (
        <Alert tone="error">
          Courses could not be loaded.{' '}
          <button type="button" className="font-medium underline" onClick={() => void load()}>
            Try again
          </button>
        </Alert>
      ) : null}

      {state === 'ready' ? (
        <>
          <CourseGrid
            courses={courses.map(toCourseSummary)}
            getCourseHref={(course) => `/courses/${course.id}`}
            emptyTitle="No courses yet"
            emptyDescription={
              isAdministrator
                ? 'Create a course in Academic setup to see it here.'
                : 'You are not enrolled in any published courses yet.'
            }
          />
          {nextCursor ? (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                disabled={loadingMore}
                onClick={async () => {
                  setLoadingMore(true);
                  await load(nextCursor);
                  setLoadingMore(false);
                }}
              >
                {loadingMore ? 'Loading…' : 'Load more courses'}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
