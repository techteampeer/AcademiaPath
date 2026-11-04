'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { LOCALE_COOKIE, LOCALES, MESSAGES, type Locale, type Messages } from '@/lib/i18n/messages';

type LocaleContextValue = { locale: Locale; t: Messages; setLocale: (locale: Locale) => void };

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * Interface language. The choice is a non-sensitive preference stored in the `ap_locale` cookie
 * (so the server renders the same language and `<html lang>`); nothing else is stored.
 */
export function LocaleProvider({ initialLocale, children }: { initialLocale: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    document.cookie = `${LOCALE_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
    document.documentElement.lang = next;
  }, []);
  const value = useMemo(() => ({ locale, t: MESSAGES[locale], setLocale }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('useLocale must be used inside LocaleProvider');
  return value;
}

/** EN / ES toggle: two native buttons with pressed state. */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { locale, setLocale, t } = useLocale();
  return (
    <div role="group" aria-label={t.common.language} className={cn('inline-flex rounded-lg border border-slate-300 bg-white p-0.5', className)}>
      {LOCALES.map((option) => (
        <button
          key={option}
          type="button"
          lang={option}
          aria-pressed={locale === option}
          onClick={() => setLocale(option)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-semibold uppercase',
            locale === option ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-100',
          )}
        >
          <span aria-hidden="true">{option}</span>
          <span className="sr-only">{option === 'en' ? 'English' : 'Español'}</span>
        </button>
      ))}
    </div>
  );
}
