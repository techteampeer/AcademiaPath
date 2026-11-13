import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { TutorView } from '@/components/tutor/TutorView';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('tutor');
}

/** `?activity=` opens the tutor on one lesson; the API decides whether the person may use it. */
export default async function TutorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ activity?: string | string[] }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const activity = typeof query.activity === 'string' && UUID.test(query.activity) ? query.activity : null;
  return <TutorView courseId={id} initialActivityId={activity} />;
}
