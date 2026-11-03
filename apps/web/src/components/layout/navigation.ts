export type NavItem = {
  href: string;
  label: string;
};

export type NavSection = {
  title: string;
  items: NavItem[];
};

/** Single source of truth for sidebar and mobile navigation. Only list routes that exist. */
export const navSections: NavSection[] = [
  {
    title: 'Overview',
    items: [{ href: '/', label: 'Home' }],
  },
  {
    title: 'Previews',
    items: [{ href: '/preview/courses', label: 'Course components' }],
  },
];

export function isActivePath(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}
