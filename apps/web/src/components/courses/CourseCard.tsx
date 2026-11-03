import { StudentProgressBar } from '@/components/students/StudentProgressBar';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import type { CourseStatus, CourseSummary } from '@/types/course';

const statusDisplay: Record<CourseStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'warning' },
  published: { label: 'Published', tone: 'success' },
  archived: { label: 'Archived', tone: 'neutral' },
};

export type CourseCardProps = {
  course: CourseSummary;
  /** Heading element for the course title, to fit the page outline. Defaults to `h3`. */
  titleAs?: 'h2' | 'h3' | 'h4';
};

export function CourseCard({ course, titleAs: Title = 'h3' }: CourseCardProps) {
  const status = statusDisplay[course.status];

  return (
    <Card as="article" className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3">
        <Title className="text-base font-semibold text-slate-900">{course.title}</Title>
        <Badge tone={status.tone}>
          <span className="sr-only">Status: </span>
          {status.label}
        </Badge>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Instructor: <span className="font-medium text-slate-700">{course.instructorName}</span>
      </p>
      <p className="mt-3 flex-1 text-sm leading-6 text-slate-600">{course.description}</p>
      <StudentProgressBar
        className="mt-5"
        value={course.progressPercent}
        accessibleLabel={`Progress in ${course.title}`}
      />
    </Card>
  );
}
