import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { ProgramsOverview } from '@/components/admin/workspace/ProgramsOverview';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('programs');
}

export default function ProgramsPage() {
  return <ProgramsOverview />;
}
