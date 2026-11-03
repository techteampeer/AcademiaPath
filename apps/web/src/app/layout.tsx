import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { SessionProvider } from '@/components/session/SessionProvider';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'AcademiaPath',
    template: '%s · AcademiaPath',
  },
  description: 'AcademiaPath — institutional learning platform for universities.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">
        <SessionProvider>
          <AppShell>{children}</AppShell>
        </SessionProvider>
      </body>
    </html>
  );
}
