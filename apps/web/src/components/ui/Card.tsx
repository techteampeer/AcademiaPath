import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type CardProps = HTMLAttributes<HTMLElement> & {
  /** Semantic element to render. Defaults to `div`. */
  as?: 'div' | 'article' | 'section' | 'li';
  /** Inner spacing. Defaults to `md`. */
  padding?: 'none' | 'md' | 'lg';
};

const paddingClasses = { none: '', md: 'p-5', lg: 'p-6 sm:p-8' } as const;

export function Card({ as: Element = 'div', padding = 'md', className, ...props }: CardProps) {
  return (
    <Element
      className={cn('rounded-xl border border-slate-200 bg-white shadow-sm', paddingClasses[padding], className)}
      {...props}
    />
  );
}
