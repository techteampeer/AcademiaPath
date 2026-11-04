'use client';

import { useLocale } from '@/components/i18n/LocaleProvider';
import type { CourseStatus } from '@/types/course';
import { CourseStatusBadge } from './CourseCard';

/** Course status badge in the interface language. */
export function LocalizedCourseStatusBadge({ status }: { status: CourseStatus }) {
  const { t } = useLocale();
  return <CourseStatusBadge status={status} label={t.status[status]} statusLabel={t.admin.status} />;
}
