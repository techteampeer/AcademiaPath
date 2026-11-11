import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * A horizontally scrollable region for a wide table that holds only text. On narrow screens keyboard users can
 * focus it (Tab) and scroll it with the arrow keys; screen readers announce it by its label (WCAG 2.1.1).
 */
export function ScrollRegion({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className={cn('relative overflow-x-auto', className)}>
      {children}
    </div>
  );
}
