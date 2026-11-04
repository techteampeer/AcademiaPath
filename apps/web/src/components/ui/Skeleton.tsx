import { cn } from '@/lib/cn';

/** Decorative placeholder block; pair with a status message for assistive technology. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-lg bg-slate-200/80', className)} />;
}

/** Loading state: a polite status message plus card-shaped skeletons. */
export function LoadingCards({ label, count = 3 }: { label: string; count?: number }) {
  return (
    <div>
      <p role="status" className="sr-only">
        {label}
      </p>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-16 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
