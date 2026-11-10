import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { GradingPolicyEditor } from '@/components/grades/GradingPolicyEditor';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('gradeCategories');
}

export default async function GradeCategoriesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GradingPolicyEditor courseId={id} />;
}
