import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

const toneClasses = {
  // A coloured leading edge plus text: status is never conveyed by colour alone (role and wording carry it).
  error: 'border-red-200 border-l-red-700 bg-red-50 text-red-800',
  success: 'border-emerald-200 border-l-emerald-600 bg-emerald-50 text-emerald-800',
  info: 'border-slate-200 border-l-gold-400 bg-slate-50 text-slate-700',
} as const;

/** Inline message. Errors are announced immediately (role="alert"); others politely (role="status"). */
export function Alert({
  tone = 'info',
  className,
  children,
}: {
  tone?: keyof typeof toneClasses;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('rounded-md border border-l-4 px-4 py-3 text-sm', toneClasses[tone], className)}>
      {children}
    </div>
  );
}
