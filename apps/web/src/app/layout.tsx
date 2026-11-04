import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { LocaleProvider } from '@/components/i18n/LocaleProvider';
import { AppShell } from '@/components/layout/AppShell';
import { SessionProvider } from '@/components/session/SessionProvider';
import { WorkspaceProvider } from '@/components/session/WorkspaceProvider';
import { isLocale, LOCALE_COOKIE, type Locale } from '@/lib/i18n/messages';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'AcademiaPath',
    template: '%s · AcademiaPath',
  },
  description: 'AcademiaPath — institutional learning platform for universities.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Interface language preference only (not a credential); defaults to English.
  const stored = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale: Locale = isLocale(stored) ? stored : 'en';
  return (
    <html lang={locale}>
      <body className="min-h-screen font-sans">
        <LocaleProvider initialLocale={locale}>
          <SessionProvider>
            <WorkspaceProvider>
              <AppShell>{children}</AppShell>
            </WorkspaceProvider>
          </SessionProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
