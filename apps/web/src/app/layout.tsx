import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { LocaleProvider } from '@/components/i18n/LocaleProvider';
import { AppShell } from '@/components/layout/AppShell';
import { SessionProvider } from '@/components/session/SessionProvider';
import { WorkspaceProvider } from '@/components/session/WorkspaceProvider';
import { UnreadSummaryProvider } from '@/components/messaging/polling';
import { MESSAGES } from '@/lib/i18n/messages';
import { serverLocale } from '@/lib/i18n/server';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: { default: 'AcademiaPath', template: '%s · AcademiaPath' },
    description: MESSAGES[await serverLocale()].meta.description,
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Interface language preference only (not a credential); defaults to English.
  const locale = await serverLocale();
  return (
    <html lang={locale}>
      <body className="min-h-screen font-sans">
        <LocaleProvider initialLocale={locale}>
          <SessionProvider>
            <WorkspaceProvider>
              <UnreadSummaryProvider>
              <AppShell>{children}</AppShell>
              </UnreadSummaryProvider>
            </WorkspaceProvider>
          </SessionProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
