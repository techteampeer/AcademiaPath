import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type EmptyStateProps = {
  title: string;
  description?: string;
  /** Optional call to action, e.g. a Button or link. */
  action?: ReactNode;
  /** Optional custom icon; a neutral default is shown otherwise. */
  icon?: ReactNode;
  /** Heading element for the title, to fit the surrounding outline. Defaults to `h3`. */
  titleAs?: 'h1' | 'h2' | 'h3' | 'h4';
  className?: string;
};

function DefaultIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-6 w-6" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.75h16.5m-16.5 0V18a2.25 2.25 0 0 0 2.25 2.25h12A2.25 2.25 0 0 0 20.25 18V9.75m-16.5 0 1.9-4.27A2.25 2.25 0 0 1 7.71 4.5h8.58a2.25 2.25 0 0 1 2.06 1.48l1.9 4.27" />
    </svg>
  );
}

export function EmptyState({ title, description, action, icon, titleAs: Title = 'h3', className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center',
        className,
      )}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-slate-500 ring-1 ring-slate-200">
        {icon ?? <DefaultIcon />}
      </div>
      <Title className="mt-4 text-base font-semibold text-slate-900">{title}</Title>
      {description ? <p className="mt-1 max-w-md text-sm text-slate-600">{description}</p> : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}
