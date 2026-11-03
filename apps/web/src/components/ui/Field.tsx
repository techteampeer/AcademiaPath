import type { InputHTMLAttributes, SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const controlClasses =
  'mt-1 block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm disabled:bg-slate-100';

type FieldProps = { id: string; label: string; error?: string; hint?: string };

function describedBy(id: string, error?: string, hint?: string) {
  return [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;
}

function FieldMessages({ id, error, hint }: Omit<FieldProps, 'label'>) {
  return (
    <>
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** Labelled text input with accessible hint and validation message. */
export function TextField({ id, label, error, hint, className, ...input }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        className={cn(controlClasses, error ? 'border-red-500' : 'border-slate-300')}
        {...input}
      />
      <FieldMessages id={id} error={error} hint={hint} />
    </div>
  );
}

/** Labelled select with accessible hint and validation message. */
export function SelectField({
  id,
  label,
  error,
  hint,
  className,
  options,
  ...select
}: FieldProps & SelectHTMLAttributes<HTMLSelectElement> & { options: Array<{ value: string; label: string }> }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        className={cn(controlClasses, error ? 'border-red-500' : 'border-slate-300')}
        {...select}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <FieldMessages id={id} error={error} hint={hint} />
    </div>
  );
}
