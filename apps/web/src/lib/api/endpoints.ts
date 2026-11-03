import { apiRequest } from './client';
import type {
  Course,
  CourseCreate,
  CoursePage,
  CourseTemplateCreate,
  CourseTemplatePage,
  CourseTemplateVersion,
  CsrfTokenResponse,
  Enrollment,
  EnrollmentCreate,
  LoginRequest,
  LoginResponse,
  MeResponse,
  Program,
  ProgramCreate,
  ProgramPage,
  SectionPage,
  Term,
  TermCreate,
  TermPage,
} from './types';

export type PageRequest = { cursor?: string | null; limit?: number };

function withPage(path: string, page?: PageRequest): string {
  const params = new URLSearchParams();
  if (page?.limit) params.set('limit', String(page.limit));
  if (page?.cursor) params.set('cursor', page.cursor);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

const course = (id: string) => `/courses/${encodeURIComponent(id)}`;

/** Typed calls for the endpoints in packages/contract/openapi.yaml. POSTs require the session's CSRF token. */
export const api = {
  login: (body: LoginRequest) => apiRequest<LoginResponse>('POST', '/auth/login', { body }),
  logout: (csrfToken: string) => apiRequest<void>('POST', '/auth/logout', { csrfToken }),
  csrfToken: () => apiRequest<CsrfTokenResponse>('GET', '/auth/csrf'),
  me: () => apiRequest<MeResponse>('GET', '/me'),

  listCourses: (page?: PageRequest) => apiRequest<CoursePage>('GET', withPage('/courses', page)),
  getCourse: (id: string) => apiRequest<Course>('GET', course(id)),
  listSections: (id: string, page?: PageRequest) => apiRequest<SectionPage>('GET', withPage(`${course(id)}/sections`, page)),

  listPrograms: (page?: PageRequest) => apiRequest<ProgramPage>('GET', withPage('/programs', page)),
  createProgram: (body: ProgramCreate, csrfToken: string) => apiRequest<Program>('POST', '/programs', { body, csrfToken }),
  listTerms: (page?: PageRequest) => apiRequest<TermPage>('GET', withPage('/terms', page)),
  createTerm: (body: TermCreate, csrfToken: string) => apiRequest<Term>('POST', '/terms', { body, csrfToken }),
  listCourseTemplates: (page?: PageRequest) => apiRequest<CourseTemplatePage>('GET', withPage('/course-templates', page)),
  createCourseTemplate: (body: CourseTemplateCreate, csrfToken: string) =>
    apiRequest<CourseTemplateVersion>('POST', '/course-templates', { body, csrfToken }),
  createCourse: (body: CourseCreate, csrfToken: string) => apiRequest<Course>('POST', '/courses', { body, csrfToken }),
  createEnrollment: (courseId: string, body: EnrollmentCreate, csrfToken: string) =>
    apiRequest<Enrollment>('POST', `${course(courseId)}/enrollments`, { body, csrfToken }),
};
