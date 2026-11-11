'use client';

import type { ReactNode } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-brand-700 focus:shadow-lg"
      >
        {t.common.skipToContent}
      </a>
      <Header />
      <div className="flex flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col bg-ivory">
          <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
            <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10">{children}</div>
          </main>
          <footer className="border-t border-slate-200 bg-parchment">
            <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-6 text-sm text-slate-600 sm:px-6 lg:px-8">
              <span aria-hidden="true" className="h-px w-8 bg-gold-400" />
              {t.common.footer}
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}
