/**
 * AcademiaPath heritage visual elements: the institutional emblem, the navigation icon set, decorative course
 * emblems and the collegiate banner. All artwork is original (no third-party imagery, logos or seals) and
 * decorative: hidden from assistive technology.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** The AcademiaPath emblem: an open book beneath a gothic arch, inside an antique-gold ring. */
export function BrandMark({ className = 'h-9 w-9' }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true" focusable="false">
      <circle cx="20" cy="20" r="19" className="fill-brand-800 stroke-gold-400" strokeWidth="1.5" />
      <circle cx="20" cy="20" r="15.6" fill="none" className="stroke-gold-400" strokeWidth=".6" opacity=".7" />
      <path d="M15.6 21V15.4Q15.6 11.6 20 9.6Q24.4 11.6 24.4 15.4V21" fill="none" className="stroke-gold-300" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M20 9.6V21" className="stroke-gold-300" strokeWidth=".8" />
      <path d="M20 29.2C17.1 27.6 13.6 27.3 10.4 28V21.4C13.6 20.6 17.1 21 20 22.6Z" className="fill-ivory" />
      <path d="M20 29.2C22.9 27.6 26.4 27.3 29.6 28V21.4C26.4 20.6 22.9 21 20 22.6Z" className="fill-parchment" />
      <path d="M20 22.6V29.2" className="stroke-gold-400" strokeWidth=".7" />
    </svg>
  );
}

export type IconName =
  | 'home'
  | 'book'
  | 'megaphone'
  | 'calendar'
  | 'chat'
  | 'bell'
  | 'users'
  | 'award'
  | 'forum'
  | 'chart'
  | 'spark'
  | 'trend'
  | 'columns'
  | 'user'
  | 'layers'
  | 'library'
  | 'sliders'
  | 'document'
  | 'key'
  | 'dot';

const ICON_PATHS: Record<IconName, ReactNode> = {
  home: <path d="M3.5 10.5 12 4l8.5 6.5M5.5 9v10.5h4.5V14h4v5.5h4.5V9" />,
  book: <path d="M4 5.5C6.5 4.6 9.5 4.8 12 6.4c2.5-1.6 5.5-1.8 8-.9v13c-2.5-.9-5.5-.7-8 .9-2.5-1.6-5.5-1.8-8-.9zM12 6.4v13" />,
  megaphone: <path d="M4 10v4h3l7 4V6l-7 4H4zM17 9.5a3.5 3.5 0 0 1 0 5M8 14l1 5" />,
  calendar: <path d="M5 6.5h14v13H5zM5 10.5h14M9 4v4M15 4v4M8.5 14h2M13.5 14h2M8.5 17h2" />,
  chat: <path d="M4.5 6h15v10h-9l-4 3.5V16h-2z" />,
  bell: <path d="M6.5 16.5h11l-1.4-2V10a4.1 4.1 0 0 0-8.2 0v4.5zM10.3 19a1.9 1.9 0 0 0 3.4 0" />,
  users: <path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5M16 11a2.5 2.5 0 1 0-.6-4.9M17 14.2c1.9.5 3.1 2 3.5 4.8" />,
  award: <path d="M12 14.5a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM9 13.6 7.5 20l4.5-2.2 4.5 2.2L15 13.6" />,
  forum: <path d="M3.5 5h11v7.5h-6L5.5 15v-2.5h-2zM17.5 9h3v7.5h-2V19l-3-2.5h-5.5V14" />,
  chart: <path d="M4.5 19.5h15M7 16.5V11M11 16.5V6.5M15 16.5v-7M19 16.5v-4" />,
  spark: <path d="M12 4c.6 3.6 2.4 5.4 6 6-3.6.6-5.4 2.4-6 6-.6-3.6-2.4-5.4-6-6 3.6-.6 5.4-2.4 6-6zM18 15.5c.3 1.5 1 2.2 2.5 2.5-1.5.3-2.2 1-2.5 2.5-.3-1.5-1-2.2-2.5-2.5 1.5-.3 2.2-1 2.5-2.5z" />,
  trend: <path d="M4 18.5 9.5 13l3.5 3 7-7.5M15 8.5h5v5" />,
  columns: <path d="M3.5 9 12 4.5 20.5 9zM5.5 19.5h13M4 21h16M6.5 10.5v7M10 10.5v7M14 10.5v7M17.5 10.5v7" />,
  user: <path d="M12 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM5 20c.8-3.8 3.6-5.8 7-5.8s6.2 2 7 5.8" />,
  layers: <path d="m12 4 8.5 4.5L12 13 3.5 8.5zM3.5 12.5 12 17l8.5-4.5M3.5 16.2 12 20.7l8.5-4.5" />,
  library: <path d="M5 4.5h3v15H5zM10 4.5h3v15h-3zM15.2 5.2l2.9-.8 3.6 14.2-2.9.8z" />,
  sliders: <path d="M5 6.5h8M17 6.5h2M5 12h2M11 12h8M5 17.5h10M19 17.5h0M13 4.5v4M7 10v4M15 15.5v4" />,
  document: <path d="M6.5 3.5h7.5l4 4v13h-11.5zM14 3.5v4h4M9 12h6M9 15.5h6" />,
  key: <path d="M14.5 13.5a4.5 4.5 0 1 0-4.2-2.9L4 17v3h3v-2h2v-2h2l1.8-1.8a4.5 4.5 0 0 0 1.7.3z" />,
  dot: <circle cx="12" cy="12" r="2.5" />,
};

/** A consistent line icon (decorative): 24px grid, 1.6 stroke. */
export function Icon({ name, className = 'h-5 w-5' }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" focusable="false">
      {ICON_PATHS[name]}
    </svg>
  );
}

/** The icon for a navigation destination. */
export function navIconFor(href: string): IconName {
  if (href === '/dashboard' || href === '/') return 'home';
  if (href === '/login') return 'key';
  if (href === '/courses') return 'book';
  if (href === '/notifications') return 'bell';
  if (href === '/academic' || href === '/admin' || href === '/admin/academics') return 'columns';
  if (href === '/admin/users') return 'user';
  if (href === '/admin/programs') return 'layers';
  if (href === '/admin/courses') return 'library';
  if (href === '/admin/setup') return 'sliders';
  if (href === '/admin/communications' || href.endsWith('/announcements')) return 'megaphone';
  if (href === '/admin/messaging' || href.endsWith('/messages')) return 'chat';
  if (href === '/admin/forums' || href.endsWith('/forum')) return 'forum';
  if (href.endsWith('/calendar')) return 'calendar';
  if (href.endsWith('/groups')) return 'users';
  if (href.endsWith('/certificates')) return 'award';
  if (href.endsWith('/grades')) return 'chart';
  if (href.endsWith('/tutor')) return 'spark';
  if (href.endsWith('/progress')) return 'trend';
  if (/^\/courses\/[^/]+$/.test(href)) return 'document';
  return 'dot';
}

/** Emblem tones from the theme (literal class names so Tailwind generates them). */
const EMBLEM_TONES = [
  'bg-brand-600 text-gold-200',
  'bg-forest-900 text-gold-200',
  'bg-slate-800 text-gold-300',
  'bg-brand-700 text-gold-100',
] as const;

/**
 * Decorative course emblem (courses have no images): a gothic-window motif and the course code's initials in a
 * tone chosen deterministically from the code, so each course keeps the same emblem.
 */
export function CourseEmblem({ code, className }: { code: string; className?: string }) {
  let hash = 0;
  for (const char of code) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const tone = EMBLEM_TONES[hash % EMBLEM_TONES.length]!;
  // The code's first segment (e.g. "ITIL" from "ITIL4-F-2026-2-A"), letters only, at most four.
  const initials = (code.split(/[-_\s.]/)[0] ?? code).replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || code.slice(0, 3).toUpperCase();
  return (
    <div aria-hidden="true" className={cn('relative shrink-0 overflow-hidden rounded-md ring-1 ring-black/5', tone, className)}>
      <svg viewBox="0 0 80 64" className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid slice">
        <g fill="none" stroke="currentColor" strokeWidth="1" opacity=".35">
          <path d="M8 64V30Q8 14 22 8Q36 14 36 30V64M22 8V64M44 64V30Q44 14 58 8Q72 14 72 30V64M58 8V64" />
          <path d="M8 40H36M44 40H72" />
        </g>
      </svg>
      <span className="absolute inset-x-0 bottom-1.5 text-center font-serif text-[0.7rem] font-semibold tracking-[0.12em]">
        {initials}
      </span>
    </div>
  );
}

/**
 * The collegiate banner used on dashboards and the landing page: the original campus illustration under a
 * burgundy wash that keeps the text readable. Content is placed on top.
 */
export function HeritageBanner({ children, className, compact = false }: { children: ReactNode; className?: string; compact?: boolean }) {
  return (
    <div className={cn('on-dark relative isolate overflow-hidden rounded-lg border border-gold-400/40 bg-brand-800 shadow-raised', className)} data-heritage-banner>
      {/* eslint-disable-next-line @next/next/no-img-element -- static decorative SVG */}
      <img src="/heritage/campus-panorama.svg" alt="" aria-hidden="true" className="absolute inset-0 -z-10 h-full w-full object-cover object-[70%_center]" />
      {/* A uniform wash on narrow screens (text spans the full width); a left-to-right fade on wide screens where the
          text sits on the left and the illustration shows on the right. Keeps ivory text above AA contrast. */}
      <div
        className="absolute inset-0 -z-10 bg-brand-900/75 xl:bg-transparent xl:bg-linear-to-r xl:from-brand-900/95 xl:via-brand-900/85 xl:via-55% xl:to-brand-800/15"
        aria-hidden="true"
      />
      <div className={cn('relative px-6 text-ivory sm:px-8', compact ? 'py-6 sm:py-7' : 'py-8 sm:py-10')}>{children}</div>
    </div>
  );
}
