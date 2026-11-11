import Link from 'next/link';
import type { ReactNode } from 'react';

export type Crumb = { label: string; href?: string };

/** Breadcrumb trail; the last item is the current page. Long titles wrap instead of overflowing. */
export function Breadcrumbs({ items, label = 'Breadcrumb' }: { items: Crumb[]; label?: string }) {
  return (
    <nav aria-label={label}>
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-slate-600">
        {items.map((crumb, index) => (
          <li key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
            {index > 0 ? (
              <span aria-hidden="true" className="text-gold-600">
                ›
              </span>
            ) : null}
            {crumb.href ? (
              <Link href={crumb.href} className="break-words text-brand-700 hover:underline">
                {crumb.label}
              </Link>
            ) : (
              <span aria-current="page" className="font-medium break-words text-slate-900">
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Consistent page heading: optional breadcrumb, kicker, h1, description and actions. */
export function PageHeader({
  title,
  description,
  kicker,
  breadcrumbs,
  breadcrumbLabel = 'Breadcrumb',
  actions,
}: {
  title: string;
  description?: ReactNode;
  kicker?: string;
  breadcrumbs?: Crumb[];
  breadcrumbLabel?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="space-y-3">
      {breadcrumbs?.length ? <Breadcrumbs items={breadcrumbs} label={breadcrumbLabel} /> : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {kicker ? <p className="text-xs font-semibold tracking-[0.12em] text-brand-700 uppercase">{kicker}</p> : null}
          <h1 className="text-[1.75rem] leading-tight font-semibold break-words text-brand-600 sm:text-[2.1rem]">{title}</h1>
          <div aria-hidden="true" className="heritage-rule mt-3 w-24" />
          {description ? <div className="mt-3 max-w-3xl text-slate-600">{description}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
