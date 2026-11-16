'use client';

import { forwardRef, useCallback, useRef, useState, type InputHTMLAttributes, type Ref } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { cn } from '@/lib/cn';

type FileInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> & {
  className?: string;
  /** The chosen file's name when the parent tracks it (for example after resetting the input); else the input's own. */
  selectedName?: string | null;
};

/**
 * AP-I18N-01: a file picker whose button and "no file chosen" text follow the interface language. The browser's own
 * file-input button is drawn in the browser's language, whatever the page language. The native input stays in the
 * page — visually hidden but focusable, labelled by the caller's <label> and announced as before — so keyboard use,
 * screen readers and automated tests (setInputFiles) work unchanged; only the visible text is replaced.
 */
export const FileInput = forwardRef(function FileInput({ className, selectedName, onChange, disabled, ...props }: FileInputProps, ref: Ref<HTMLInputElement>) {
  const { t } = useLocale();
  const inner = useRef<HTMLInputElement | null>(null);
  const [ownName, setOwnName] = useState<string | null>(null);
  const setRefs = useCallback(
    (node: HTMLInputElement | null) => {
      inner.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  const name = selectedName !== undefined ? selectedName : ownName;
  return (
    <div className={cn('mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1', className)}>
      <input
        ref={setRefs}
        type="file"
        disabled={disabled}
        className="peer sr-only"
        onChange={(event) => {
          setOwnName(event.target.files?.[0]?.name ?? null);
          onChange?.(event);
        }}
        {...props}
      />
      {/* Mouse users click the visible button; keyboard users focus the input itself (outlined here). */}
      <span
        aria-hidden="true"
        onClick={() => {
          if (!disabled) inner.current?.click();
        }}
        className={cn(
          'inline-flex cursor-pointer items-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-600',
          disabled && 'cursor-not-allowed opacity-60',
        )}
        data-file-button
      >
        {t.common.chooseFile}
      </span>
      <span aria-hidden="true" className="min-w-0 text-sm break-all text-slate-600" data-file-name>
        {name ?? t.common.noFileChosen}
      </span>
    </div>
  );
});
