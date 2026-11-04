import { apiRequest } from './client';
import type {
  Activity,
  ActivityCreate,
  AssignmentGradeInput,
  AssignmentSubmissionDetail,
  AssignmentSubmissionPage,
  ActivityPage,
  ActivityReviewDecision,
  ActivityUpdate,
  Course,
  CourseCreate,
  CoursePage,
  CourseTemplateCreate,
  CourseTemplatePage,
  CourseTemplateVersion,
  CsrfTokenResponse,
  Enrollment,
  EnrollmentCreate,
  Gradebook,
  GradeReleaseResult,
  LoginRequest,
  LoginResponse,
  MeResponse,
  Program,
  ProgramCreate,
  ProgramPage,
  QuizAnswersSave,
  QuizAttemptResult,
  QuizAttemptSubmit,
  QuizQuestion,
  QuizQuestionInput,
  QuizQuestionList,
  QuizResultPage,
  SectionPage,
  StudentAssignmentStatus,
  StudentAssignmentSubmission,
  StudentGrades,
  StudentQuizAttempt,
  StudentQuizAttemptSummary,
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
const activity = (courseId: string, activityId: string) => `${course(courseId)}/activities/${encodeURIComponent(activityId)}`;
const attempt = (courseId: string, attemptId: string) => `${course(courseId)}/attempts/${encodeURIComponent(attemptId)}`;
const sectionActivities = (courseId: string, sectionId: string) =>
  `${course(courseId)}/sections/${encodeURIComponent(sectionId)}/activities`;

/** Typed calls for the endpoints in packages/contract/openapi.yaml. Writes require the session's CSRF token. */
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

  listActivities: (courseId: string, sectionId: string, page?: PageRequest) =>
    apiRequest<ActivityPage>('GET', withPage(sectionActivities(courseId, sectionId), page)),
  createActivity: (courseId: string, sectionId: string, body: ActivityCreate, csrfToken: string) =>
    apiRequest<Activity>('POST', sectionActivities(courseId, sectionId), { body, csrfToken }),
  getActivity: (courseId: string, activityId: string) => apiRequest<Activity>('GET', activity(courseId, activityId)),
  updateActivity: (courseId: string, activityId: string, body: ActivityUpdate, csrfToken: string) =>
    apiRequest<Activity>('PUT', activity(courseId, activityId), { body, csrfToken }),
  submitActivity: (courseId: string, activityId: string, csrfToken: string) =>
    apiRequest<Activity>('POST', `${activity(courseId, activityId)}/submit`, { csrfToken }),
  reviewActivity: (courseId: string, activityId: string, body: ActivityReviewDecision, csrfToken: string) =>
    apiRequest<Activity>('POST', `${activity(courseId, activityId)}/review`, { body, csrfToken }),

  // Quizzes. Question lists (with answer keys) and results are staff-only; the API grades every attempt.
  listQuizQuestions: (courseId: string, quizId: string) => apiRequest<QuizQuestionList>('GET', `${activity(courseId, quizId)}/questions`),
  addQuizQuestion: (courseId: string, quizId: string, body: QuizQuestionInput, csrfToken: string) =>
    apiRequest<QuizQuestion>('POST', `${activity(courseId, quizId)}/questions`, { body, csrfToken }),
  removeQuizQuestion: (courseId: string, quizId: string, questionId: string, csrfToken: string) =>
    apiRequest<void>('DELETE', `${activity(courseId, quizId)}/questions/${encodeURIComponent(questionId)}`, { csrfToken }),
  listQuizResults: (courseId: string, quizId: string, page?: PageRequest) =>
    apiRequest<QuizResultPage>('GET', withPage(`${activity(courseId, quizId)}/results`, page)),
  getQuizResult: (courseId: string, quizId: string, attemptId: string) =>
    apiRequest<QuizAttemptResult>('GET', `${activity(courseId, quizId)}/results/${encodeURIComponent(attemptId)}`),
  startQuizAttempt: (courseId: string, quizId: string, csrfToken: string) =>
    apiRequest<StudentQuizAttempt>('POST', `${activity(courseId, quizId)}/attempts`, { csrfToken }),
  myQuizAttempts: (courseId: string, quizId: string) => apiRequest<StudentQuizAttemptSummary>('GET', `${activity(courseId, quizId)}/attempts/mine`),
  getQuizAttempt: (courseId: string, attemptId: string) => apiRequest<StudentQuizAttempt>('GET', attempt(courseId, attemptId)),
  saveQuizAnswers: (courseId: string, attemptId: string, body: QuizAnswersSave, csrfToken: string) =>
    apiRequest<StudentQuizAttempt>('PUT', `${attempt(courseId, attemptId)}/answers`, { body, csrfToken }),
  submitQuizAttempt: (courseId: string, attemptId: string, body: QuizAttemptSubmit, csrfToken: string) =>
    apiRequest<StudentQuizAttempt>('POST', `${attempt(courseId, attemptId)}/submit`, { body, csrfToken }),

  // Assignments and grades. The API calculates every grade; the browser only displays them.
  submitAssignment: (courseId: string, activityId: string, body: string, csrfToken: string) =>
    apiRequest<StudentAssignmentSubmission>('POST', `${activity(courseId, activityId)}/submissions`, { body: { body }, csrfToken }),
  myAssignmentStatus: (courseId: string, activityId: string) =>
    apiRequest<StudentAssignmentStatus>('GET', `${activity(courseId, activityId)}/submissions/mine`),
  listSubmissions: (courseId: string, activityId: string, page?: PageRequest) =>
    apiRequest<AssignmentSubmissionPage>('GET', withPage(`${activity(courseId, activityId)}/submissions`, page)),
  getSubmission: (courseId: string, activityId: string, submissionId: string) =>
    apiRequest<AssignmentSubmissionDetail>('GET', `${activity(courseId, activityId)}/submissions/${encodeURIComponent(submissionId)}`),
  gradeSubmission: (courseId: string, activityId: string, submissionId: string, body: AssignmentGradeInput, csrfToken: string) =>
    apiRequest<AssignmentSubmissionDetail>('PUT', `${activity(courseId, activityId)}/submissions/${encodeURIComponent(submissionId)}/grade`, {
      body,
      csrfToken,
    }),
  releaseGrades: (courseId: string, activityId: string, csrfToken: string) =>
    apiRequest<GradeReleaseResult>('POST', `${activity(courseId, activityId)}/grades/release`, { csrfToken }),
  getGradebook: (courseId: string, page?: PageRequest) => apiRequest<Gradebook>('GET', withPage(`${course(courseId)}/gradebook`, page)),
  myGrades: (courseId: string) => apiRequest<StudentGrades>('GET', `${course(courseId)}/grades/mine`),
};
