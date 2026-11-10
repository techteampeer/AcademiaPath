import type { CourseRole, CurrentUser } from '@/lib/api/types';
import type { Messages } from '@/lib/i18n/messages';

export type NavItem = {
  href: string;
  label: string;
  /** Other path prefixes that mark this item as current. */
  activeFor?: string[];
  /** Match the path exactly (used for course overview links). */
  exact?: boolean;
};

export type NavSection = { id: string; title: string; items: NavItem[] };

const COURSE_PATH = /^\/courses\/([0-9a-f-]{36})(?:\/|$)/i;

/** The course id when the current page belongs to one course. */
export const currentCourseId = (pathname: string) => COURSE_PATH.exec(pathname)?.[1] ?? null;

/**
 * Navigation built from the real session: system role (administrator) plus the course role the user
 * holds in the course being viewed. Hiding links is only a convenience; the API enforces every
 * permission and pages check access before loading protected data.
 */
export function buildNavigation(
  t: Messages,
  user: Pick<CurrentUser, 'systemRole'> | null,
  pathname: string,
  roleByCourse: Map<string, CourseRole | null>,
  /** Whether the user holds program-management grants (shows the Academic management workspace). */
  managesPrograms = false,
): NavSection[] {
  if (!user) {
    return [{ id: 'public', title: t.nav.main, items: [{ href: '/', label: t.nav.home }, { href: '/login', label: t.common.signIn }] }];
  }
  const isAdmin = user.systemRole === 'administrator';
  const sections: NavSection[] = [
    {
      id: 'workspace',
      title: t.nav.workspace,
      items: [
        { href: '/dashboard', label: t.nav.dashboard },
        { href: '/courses', label: t.nav.myCourses, exact: true },
        ...(managesPrograms && !isAdmin ? [{ href: '/academic', label: t.nav.academicManagement }] : []),
      ],
    },
  ];
  if (isAdmin) {
    sections.push({
      id: 'administration',
      title: t.nav.administration,
      items: [
        { href: '/admin', label: t.nav.adminOverview, exact: true },
        { href: '/admin/users', label: t.nav.users },
        { href: '/admin/academics', label: t.nav.academicStructure },
        { href: '/admin/programs', label: t.nav.programsSubjects },
        { href: '/admin/courses', label: t.nav.coursesEnrollments },
        { href: '/admin/setup', label: t.nav.courseSetup },
      ],
    });
  }
  const courseId = currentCourseId(pathname);
  if (courseId && (roleByCourse.has(courseId) || isAdmin)) {
    const role = roleByCourse.get(courseId) ?? null;
    const base = `/courses/${courseId}`;
    const items: NavItem[] = [{ href: base, label: t.nav.courseContent, exact: true, activeFor: [`${base}/activities`, `${base}/attempts`] }];
    if (role === 'instructor' || role === 'non_editing_instructor' || (isAdmin && role === null)) items.push({ href: `${base}/grades`, label: t.nav.gradebook });
    if (role === 'student') items.push({ href: `${base}/grades`, label: t.nav.myGrades });
    if (role === 'student' || role === 'instructor' || role === 'non_editing_instructor') items.push({ href: `${base}/tutor`, label: t.nav.tutor });
    sections.push({ id: 'course', title: t.nav.currentCourse, items });
  }
  return sections;
}

const matches = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export function isActivePath(pathname: string, item: Pick<NavItem, 'href' | 'activeFor' | 'exact'>): boolean {
  if (item.href === '/' || item.exact) return pathname === item.href || (item.activeFor ?? []).some((prefix) => matches(pathname, prefix));
  return matches(pathname, item.href) || (item.activeFor ?? []).some((prefix) => matches(pathname, prefix));
}
