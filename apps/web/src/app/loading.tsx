'use client';

import { useLocale } from '@/components/i18n/LocaleProvider';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Shown the moment a link is followed, while the next page is fetched from the server, so every navigation gives
 * immediate feedback (slow networks and cold servers otherwise leave the previous page on screen with no sign of
 * progress). The status message is announced politely; the shapes are decorative.
 */
export default function RouteLoading() {
  const { t } = useLocale();
  return (
    <div className="space-y-6" data-route-loading="">
      <p role="status" className="sr-only">
        {t.common.navigating}
      </p>
      <div className="space-y-3">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-8 w-2/3 max-w-md" />
        <Skeleton className="h-4 w-1/2 max-w-sm" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-3 rounded-lg border border-slate-200 bg-white p-5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-16 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
