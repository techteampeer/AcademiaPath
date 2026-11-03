import type { CurrentUser } from '@/lib/api/types';

/** Who sees a link. Hiding links is only a convenience; the API enforces every permission. */
export type NavAccess = 'public' | 'authenticated' | 'administrator';

export type NavItem = {
  href: string;
  label: string;
  access?: NavAccess;
  /** Other path prefixes that mark this item as current (e.g. course detail pages). */
  activeFor?: string[];
};

export type NavSection = {
  title: string;
  items: NavItem[];
};

/** Single source of truth for sidebar and mobile navigation. Only list routes that exist. */
export const navSections: NavSection[] = [
  {
    title: 'Overview',
    items: [
      { href: '/', label: 'Home' },
      { href: '/dashboard', label: 'Dashboard', access: 'authenticated', activeFor: ['/courses'] },
    ],
  },
  {
    title: 'Administration',
    items: [{ href: '/admin/setup', label: 'Academic setup', access: 'administrator' }],
  },
  {
    title: 'Previews',
    items: [{ href: '/preview/courses', label: 'Course components' }],
  },
];

export function isNavItemVisible(item: NavItem, user: Pick<CurrentUser, 'systemRole'> | null): boolean {
  switch (item.access ?? 'public') {
    case 'public':
      return true;
    case 'authenticated':
      return user !== null;
    case 'administrator':
      return user?.systemRole === 'administrator';
  }
}

const matches = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export function isActivePath(pathname: string, item: Pick<NavItem, 'href' | 'activeFor'>): boolean {
  if (item.href === '/') return pathname === '/';
  return matches(pathname, item.href) || (item.activeFor ?? []).some((prefix) => matches(pathname, prefix));
}
