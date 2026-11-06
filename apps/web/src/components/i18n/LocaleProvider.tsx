'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { LOCALE_COOKIE, LOCALES, MESSAGES, type Locale, type Messages } from '@/lib/i18n/messages';

type LocaleContextValue = { locale: Locale; t: Messages; setLocale: (locale: Locale) => void };

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * Interface language. The choice is a non-sensitive preference stored in the `ap_locale` cookie
 * (so the server renders the same language, page titles and `<html lang>`); nothing else is stored,
 * and it is independent of the session, so it survives sign-in, sign-out and reloads.
 */
export function LocaleProvider({ initialLocale, children }: { initialLocale: Locale; children: ReactNode }) {
  const router = useRouter();
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const setLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);
      document.cookie = `${LOCALE_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
      document.documentElement.lang = next;
      // Re-render server parts (page title) in the new language; client state and the current page are kept.
      router.refresh();
    },
    [router],
  );
  const value = useMemo(() => ({ locale, t: MESSAGES[locale], setLocale }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('useLocale must be used inside LocaleProvider');
  return value;
}

/**
 * [ EN | ES ] segmented control: two native buttons (keyboard accessible) in a labelled group. The
 * selected language is filled and announced with `aria-pressed`; each button's accessible name is
 * the language's own name.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { locale, setLocale, t } = useLocale();
  return (
    <div
      role="group"
      aria-label={t.common.language}
      className={cn('inline-flex shrink-0 items-center divide-x divide-slate-300 overflow-hidden rounded-lg border border-slate-300 bg-white', className)}
    >
      {LOCALES.map((option) => {
        const selected = locale === option;
        return (
          <button
            key={option}
            type="button"
            lang={option}
            aria-pressed={selected}
            onClick={() => {
              if (!selected) setLocale(option);
            }}
            className={cn(
              'min-h-9 min-w-10 px-2.5 text-xs font-semibold tracking-wide uppercase focus-visible:relative focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand-600',
              selected ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-100',
            )}
          >
            <span aria-hidden="true">{option}</span>
            <span className="sr-only">{option === 'en' ? 'English' : 'Español'}</span>
          </button>
        );
      })}
    </div>
  );
}
