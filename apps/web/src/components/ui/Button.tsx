import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'inverse' | 'light';
export type ButtonSize = 'sm' | 'md' | 'lg';

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'border border-brand-600 bg-brand-600 text-white shadow-panel hover:border-brand-700 hover:bg-brand-700',
  secondary: 'border border-brand-600/35 bg-white text-brand-700 shadow-panel hover:border-brand-600/60 hover:bg-brand-50',
  ghost: 'text-slate-700 hover:bg-slate-100 hover:text-slate-900',
  /** On burgundy or forest surfaces. */
  inverse: 'border border-ivory/45 text-ivory hover:border-ivory/80 hover:bg-white/10',
  /** The filled call to action on burgundy or forest surfaces. */
  light: 'border border-gold-300 bg-ivory text-brand-600 shadow-panel hover:border-gold-200 hover:bg-white',
};

// Minimum (not fixed) heights so long labels, e.g. in Spanish, wrap inside the button instead of overflowing it.
const sizeClasses: Record<ButtonSize, string> = {
  sm: 'min-h-8 px-3 py-1 text-sm',
  md: 'min-h-10 px-4 py-2 text-sm',
  lg: 'min-h-12 px-6 py-2.5 text-base',
};

/**
 * Button styles as a class string, so links (e.g. Next.js `Link`) can look
 * like buttons while keeping correct link semantics.
 */
export function buttonClasses({
  variant = 'primary',
  size = 'md',
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return cn(
    'inline-flex items-center justify-center gap-2 rounded-md text-center font-medium transition-colors',
    'disabled:pointer-events-none disabled:opacity-50',
    variantClasses[variant],
    sizeClasses[size],
    className,
  );
}

export type ButtonProps = ComponentPropsWithoutRef<'button'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button({ variant, size, className, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={buttonClasses({ variant, size, className })} {...props} />;
}
