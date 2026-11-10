'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isApiError } from '@/lib/api/client';
import { api, loadAll } from '@/lib/api/endpoints';
import type { Course, CourseRole, CurrentUser, ManagedProgram } from '@/lib/api/types';
import { useSession } from './SessionProvider';

type WorkspaceValue = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Courses the API lets this user see (administrators: all courses). */
  courses: Course[];
  /** Course roles the user actually holds, per course (null: no enrollment, e.g. administrator access). */
  roleByCourse: Map<string, CourseRole | null>;
  /** Distinct course roles held across courses; a user can hold different roles in different courses. */
  rolesHeld: Set<CourseRole>;
  /** Programs the user manages through explicit grants (empty for administrators, who manage everything). */
  managedPrograms: ManagedProgram[];
  reload: () => Promise<void>;
};

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

/**
 * Role context for navigation and dashboards, derived from GET /courses (each course carries the
 * caller's `viewerRole`). It only shapes the UI; the API authorizes every request.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { session, handleUnauthorized } = useSession();
  const userId = session.status === 'authenticated' ? session.user.id : null;
  const isAdministrator = session.status === 'authenticated' && session.user.systemRole === 'administrator';
  const [status, setStatus] = useState<WorkspaceValue['status']>('idle');
  const [courses, setCourses] = useState<Course[]>([]);
  const [managedPrograms, setManagedPrograms] = useState<ManagedProgram[]>([]);

  const reload = useCallback(async () => {
    if (!userId) return;
    setStatus('loading');
    try {
      const [loaded, managed] = await Promise.all([
        loadAll((page) => api.listCourses(page)),
        isAdministrator ? Promise.resolve(null) : api.myManagedPrograms(),
      ]);
      setCourses(loaded);
      setManagedPrograms(managed?.items ?? []);
      setStatus('ready');
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setStatus('error');
    }
  }, [userId, isAdministrator, handleUnauthorized]);

  useEffect(() => {
    if (userId) void reload();
    else {
      setCourses([]);
      setManagedPrograms([]);
      setStatus('idle');
    }
  }, [userId, reload]);

  const value = useMemo(() => {
    const roleByCourse = new Map(courses.map((course) => [course.id, course.viewerRole] as const));
    const rolesHeld = new Set(courses.flatMap((course) => (course.viewerRole ? [course.viewerRole] : [])));
    return { status, courses, roleByCourse, rolesHeld, managedPrograms, reload };
  }, [status, courses, managedPrograms, reload]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return value;
}

/** Where a user lands after signing in: administrators on the administration overview, everyone else on their dashboard. */
export const landingPathFor = (user: Pick<CurrentUser, 'systemRole'>) => (user.systemRole === 'administrator' ? '/admin' : '/dashboard');

/** Only same-site paths are accepted as a post-login destination. */
export function safeNextPath(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/login')) return null;
  return value;
}
