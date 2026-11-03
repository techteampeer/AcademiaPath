import type { CourseSummary } from '@/types/course';

/**
 * SYNTHETIC DEMONSTRATION DATA.
 * Fictional courses, instructors and progress values for /preview/courses only.
 * Not loaded from the AcademiaPath API or database.
 */
export const demoCourses: CourseSummary[] = [
  {
    id: 'demo-itil-fundamentals',
    title: 'ITIL Fundamentals',
    description:
      'Core IT service management concepts: the service value system, guiding principles and key practices for delivering value to the organization.',
    instructorName: 'Elena Ramírez',
    progressPercent: 72,
    status: 'published',
  },
  {
    id: 'demo-project-management-fundamentals',
    title: 'Project Management Fundamentals',
    description:
      'Plan, execute and close projects: scope, schedule, cost, risk and stakeholder management across the project life cycle.',
    instructorName: 'Martín Castillo',
    progressPercent: 100,
    status: 'archived',
  },
  {
    id: 'demo-introduction-to-ai',
    title: 'Introduction to AI',
    description:
      'Foundations of artificial intelligence: machine learning basics, common applications, limitations and responsible use.',
    instructorName: 'Lucía Fernández',
    progressPercent: 0,
    status: 'draft',
  },
];
