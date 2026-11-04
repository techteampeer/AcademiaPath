import type { Metadata } from 'next';
import { ProgramsOverview } from '@/components/admin/workspace/ProgramsOverview';

export const metadata: Metadata = { title: 'Programs & subjects' };

export default function ProgramsPage() {
  return <ProgramsOverview />;
}
