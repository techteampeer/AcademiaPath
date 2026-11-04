import Link from 'next/link';
import { StudentProgressBar } from '@/components/students/StudentProgressBar';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import type { CourseStatus, CourseSummary } from '@/types/course';

const statusDisplay: Record<CourseStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'warning' },
  published: { label: 'Published', tone: 'success' },
  archived: { label: 'Archived', tone: 'neutral' },
};

/** `label` and `statusLabel` let localized screens pass translated text; defaults are English. */
export function CourseStatusBadge({ status, label, statusLabel = 'Status' }: { status: CourseStatus; label?: string; statusLabel?: string }) {
  const display = statusDisplay[status];
  return (
    <Badge tone={display.tone}>
      <span className="sr-only">{statusLabel}: </span>
      {label ?? display.label}
    </Badge>
  );
}

export type CourseCardProps = {
  course: CourseSummary;
  /** Heading element for the course title, to fit the page outline. Defaults to `h3`. */
  titleAs?: 'h2' | 'h3' | 'h4';
  /** When set, the title links to the course. */
  href?: string;
};

export function CourseCard({ course, titleAs: Title = 'h3', href }: CourseCardProps) {
  return (
    <Card as="article" className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3">
        <Title className="text-base font-semibold text-slate-900">
          {href ? (
            <Link href={href} className="rounded hover:text-brand-700 hover:underline">
              {course.title}
            </Link>
          ) : (
            course.title
          )}
        </Title>
        <CourseStatusBadge status={course.status} />
      </div>
      {course.subtitle ? <p className="mt-1 text-sm text-slate-500">{course.subtitle}</p> : null}
      {course.instructorName ? (
        <p className="mt-1 text-sm text-slate-500">
          Instructor: <span className="font-medium text-slate-700">{course.instructorName}</span>
        </p>
      ) : null}
      {course.description ? <p className="mt-3 flex-1 text-sm leading-6 text-slate-600">{course.description}</p> : <div className="flex-1" />}
      {typeof course.progressPercent === 'number' ? (
        <StudentProgressBar
          className="mt-5"
          value={course.progressPercent}
          accessibleLabel={`Progress in ${course.title}`}
        />
      ) : null}
    </Card>
  );
}
