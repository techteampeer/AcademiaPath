import { API_BASE, ApiError, apiRequest, apiUpload } from './client';
import type {
  AccountInvitation,
  Activity,
  ActivationPreview,
  ActivityCreate,
  AssignmentGradeInput,
  AssignmentSubmissionDetail,
  AssignmentSubmissionPage,
  ActivityPage,
  ActivityReviewDecision,
  ActivityUpdate,
  ActivityCompletion,
  ActivityOrganization,
  ActivityOrganizationResult,
  Course,
  CourseCreate,
  CourseLifecycle,
  CourseProgress,
  CourseUpdate,
  CoursePage,
  CourseTemplateCreate,
  CourseTemplateDetail,
  CourseTemplatePage,
  CourseTemplateVersionList,
  CourseTemplateVersion,
  CsrfTokenResponse,
  DocumentDetail,
  Enrollment,
  EnrollmentCreate,
  EnrollmentImportResult,
  EnrollmentPage,
  EnrollmentUpdate,
  Gradebook,
  GradeReleaseResult,
  LoginRequest,
  LoginResponse,
  ManagedProgramList,
  MeResponse,
  MyProgressList,
  Program,
  ProgramCreate,
  ProgramManager,
  ProgramManagerList,
  ProgramPage,
  ProgramUpdate,
  QuizAnswersSave,
  QuizAttemptResult,
  QuizAttemptSubmit,
  QuizQuestion,
  QuizQuestionInput,
  QuizFeedback,
  QuizQuestionList,
  QuizResultPage,
  ResourceFolder,
  ResourceFolderList,
  Section,
  SectionCreate,
  SectionList,
  SectionPage,
  SectionPrerequisiteList,
  SectionPrerequisites,
  SectionProgress,
  SectionUpdate,
  StudentAssignmentStatus,
  StudentAssignmentSubmission,
  StudentGrades,
  GradingPolicy,
  GradingPolicyInput,
  StudentGradebook,
  GradeSelectionRelease,
  GradeSelectionReleaseResult,
  CertificatePolicy,
  CertificatePolicyInput,
  CourseCertificateEligibility,
  Certificate,
  CertificateList,
  CertificatePage,
  MyCourseCertificates,
  MyCertificates,
  CertificateVerification,
  Announcement,
  AnnouncementInput,
  AnnouncementPage,
  AnnouncementStatus,
  AnnouncementUpdate,
  UnreadCount,
  Calendar,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventList,
  Conversation,
  ConversationPage,
  CourseMessaging,
  Message,
  MessagePage,
  MessagingSummary,
  NotificationPage,
  AdminCourseConversationList,
  LockResult,
  AdminForumCourseList,
  ForumPost,
  ForumPostAction,
  ForumPostPage,
  ForumTopic,
  ForumTopicAction,
  ForumTopicInput,
  ForumTopicPage,
  StudentProgressPage,
  StudentQuizAttempt,
  StudentQuizAttemptSummary,
  TutorLanguage,
  TutorMessageResponse,
  TutorPracticeResponse,
  TutorUsage,
  Term,
  TermCreate,
  TermPage,
  TermUpdate,
  UserCreate,
  UserCreateResult,
  UserDetail,
  UserPage,
  UserUpdate,
} from './types';

export type PageRequest = { cursor?: string | null; limit?: number };

export type UserFilters = { q?: string; status?: 'active' | 'inactive' | ''; activation?: 'activated' | 'pending' | '' };

const user = (id: string) => `/users/${encodeURIComponent(id)}`;

function withPage(path: string, page?: PageRequest): string {
  const params = new URLSearchParams();
  if (page?.limit) params.set('limit', String(page.limit));
  if (page?.cursor) params.set('cursor', page.cursor);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

const course = (id: string) => `/courses/${encodeURIComponent(id)}`;

export type CourseFilters = { termId?: string; programId?: string; templateId?: string };

function withFilters(path: string, filters: CourseFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  const query = params.toString();
  if (!query) return path;
  return path.includes('?') ? `${path}&${query}` : `${path}?${query}`;
}

/** Follows `nextCursor` until every page is loaded (bounded, for administration screens). */
export async function loadAll<T>(fetchPage: (page: PageRequest) => Promise<{ items: T[]; nextCursor: string | null }>, maxPages = 50): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i += 1) {
    const page = await fetchPage({ limit: 100, cursor });
    items.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return items;
}
/** Query string from the defined values only. */
const rangeParams = (values: Record<string, string | null | undefined>) =>
  new URLSearchParams(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')).toString();
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

  listCourses: (page?: PageRequest, filters: CourseFilters = {}) => apiRequest<CoursePage>('GET', withFilters(withPage('/courses', page), filters)),
  getCourse: (id: string) => apiRequest<Course>('GET', course(id)),
  listSections: (id: string, page?: PageRequest) => apiRequest<SectionPage>('GET', withPage(`${course(id)}/sections`, page)),

  listPrograms: (page?: PageRequest) => apiRequest<ProgramPage>('GET', withPage('/programs', page)),
  createProgram: (body: ProgramCreate, csrfToken: string) => apiRequest<Program>('POST', '/programs', { body, csrfToken }),
  updateProgram: (id: string, body: ProgramUpdate, csrfToken: string) =>
    apiRequest<Program>('PUT', `/programs/${encodeURIComponent(id)}`, { body, csrfToken }),
  listTerms: (page?: PageRequest) => apiRequest<TermPage>('GET', withPage('/terms', page)),
  createTerm: (body: TermCreate, csrfToken: string) => apiRequest<Term>('POST', '/terms', { body, csrfToken }),
  updateTerm: (id: string, body: TermUpdate, csrfToken: string) => apiRequest<Term>('PUT', `/terms/${encodeURIComponent(id)}`, { body, csrfToken }),
  getCourseTemplate: (id: string) => apiRequest<CourseTemplateDetail>('GET', `/course-templates/${encodeURIComponent(id)}`),
  listCourseTemplates: (page?: PageRequest, programId?: string) => {
    const path = withPage('/course-templates', page);
    return apiRequest<CourseTemplatePage>('GET', programId ? `${path}${path.includes('?') ? '&' : '?'}programId=${encodeURIComponent(programId)}` : path);
  },
  listCourseTemplateVersions: (id: string) => apiRequest<CourseTemplateVersionList>('GET', `/course-templates/${encodeURIComponent(id)}/versions`),

  // Program-scoped academic management (grants are administrator-only; the API authorizes every subject change).
  myManagedPrograms: () => apiRequest<ManagedProgramList>('GET', '/me/managed-programs'),
  listProgramManagers: (programId: string) => apiRequest<ProgramManagerList>('GET', `/programs/${encodeURIComponent(programId)}/managers`),
  grantProgramManager: (programId: string, email: string, csrfToken: string) =>
    apiRequest<ProgramManager>('POST', `/programs/${encodeURIComponent(programId)}/managers`, { body: { email }, csrfToken }),
  revokeProgramManager: (programId: string, userId: string, csrfToken: string) =>
    apiRequest<void>('DELETE', `/programs/${encodeURIComponent(programId)}/managers/${encodeURIComponent(userId)}`, { csrfToken }),
  createCourseTemplate: (body: CourseTemplateCreate, csrfToken: string) =>
    apiRequest<CourseTemplateVersion>('POST', '/course-templates', { body, csrfToken }),
  createCourse: (body: CourseCreate, csrfToken: string) => apiRequest<Course>('POST', '/courses', { body, csrfToken }),
  listEnrollments: (courseId: string, page?: PageRequest) => apiRequest<EnrollmentPage>('GET', withPage(`${course(courseId)}/enrollments`, page)),
  createEnrollment: (courseId: string, body: EnrollmentCreate, csrfToken: string) =>
    apiRequest<Enrollment>('POST', `${course(courseId)}/enrollments`, { body, csrfToken }),
  updateEnrollment: (courseId: string, enrollmentId: string, body: EnrollmentUpdate, csrfToken: string) =>
    apiRequest<Enrollment>('PUT', `${course(courseId)}/enrollments/${encodeURIComponent(enrollmentId)}`, { body, csrfToken }),
  deleteEnrollment: (courseId: string, enrollmentId: string, csrfToken: string) =>
    apiRequest<void>('DELETE', `${course(courseId)}/enrollments/${encodeURIComponent(enrollmentId)}`, { csrfToken }),

  // Course lifecycle (administrators). Every change names the course `version` it is based on.
  getCourseLifecycle: (id: string) => apiRequest<CourseLifecycle>('GET', `${course(id)}/lifecycle`),
  updateCourse: (id: string, body: CourseUpdate, csrfToken: string) => apiRequest<Course>('PUT', course(id), { body, csrfToken }),
  publishCourse: (id: string, version: number, csrfToken: string) => apiRequest<Course>('POST', `${course(id)}/publish`, { body: { version }, csrfToken }),
  unpublishCourse: (id: string, version: number, csrfToken: string) => apiRequest<Course>('POST', `${course(id)}/unpublish`, { body: { version }, csrfToken }),
  createSection: (id: string, body: SectionCreate, csrfToken: string) => apiRequest<Section>('POST', `${course(id)}/sections`, { body, csrfToken }),
  updateSection: (id: string, sectionId: string, body: SectionUpdate, csrfToken: string) =>
    apiRequest<Section>('PUT', `${course(id)}/sections/${encodeURIComponent(sectionId)}`, { body, csrfToken }),
  reorderSections: (id: string, sectionIds: string[], csrfToken: string) =>
    apiRequest<SectionList>('PUT', `${course(id)}/sections/order`, { body: { sectionIds }, csrfToken }),
  importEnrollments: (courseId: string, csv: string, apply: boolean, csrfToken: string) =>
    apiRequest<EnrollmentImportResult>('POST', `${course(courseId)}/enrollments/import`, { body: { csv, apply }, csrfToken }),

  // User accounts (administrators). Passwords and activation tokens are never returned by these reads.
  listUsers: (filters: UserFilters, page?: PageRequest) => {
    const path = withPage('/users', page);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    const query = params.toString();
    return apiRequest<UserPage>('GET', query ? `${path}${path.includes('?') ? '&' : '?'}${query}` : path);
  },
  getUser: (id: string) => apiRequest<UserDetail>('GET', user(id)),
  createUser: (body: UserCreate, csrfToken: string) => apiRequest<UserCreateResult>('POST', '/users', { body, csrfToken }),
  updateUser: (id: string, body: UserUpdate, csrfToken: string) => apiRequest<UserDetail>('PUT', user(id), { body, csrfToken }),
  deactivateUser: (id: string, csrfToken: string) => apiRequest<UserDetail>('POST', `${user(id)}/deactivate`, { csrfToken }),
  reactivateUser: (id: string, csrfToken: string) => apiRequest<UserDetail>('POST', `${user(id)}/reactivate`, { csrfToken }),
  issueInvitation: (id: string, csrfToken: string) => apiRequest<AccountInvitation>('POST', `${user(id)}/invitations`, { csrfToken }),
  /** Public: the token travels in the request body only (never in a URL the server sees). */
  previewActivation: (token: string) => apiRequest<ActivationPreview>('POST', '/auth/activation/preview', { body: { token } }),
  activateAccount: (token: string, password: string) => apiRequest<void>('POST', '/auth/activate', { body: { token, password } }),

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
  // Certificates (AP-024): eligibility, issuance and verification are decided by the API.
  getCertificatePolicy: (courseId: string) => apiRequest<CertificatePolicy>('GET', `${course(courseId)}/certificate-policy`),
  saveCertificatePolicy: (courseId: string, body: CertificatePolicyInput, csrfToken: string) =>
    apiRequest<CertificatePolicy>('PUT', `${course(courseId)}/certificate-policy`, { body, csrfToken }),
  getCertificateEligibility: (courseId: string) => apiRequest<CourseCertificateEligibility>('GET', `${course(courseId)}/certificates/eligibility`),
  listCourseCertificates: (courseId: string) => apiRequest<CertificateList>('GET', `${course(courseId)}/certificates`),
  issueCertificate: (courseId: string, userId: string, csrfToken: string) =>
    apiRequest<Certificate>('POST', `${course(courseId)}/certificates`, { body: { userId }, csrfToken }),
  revokeCertificate: (courseId: string, certificateId: string, reason: string, csrfToken: string) =>
    apiRequest<Certificate>('POST', `${course(courseId)}/certificates/${certificateId}/revoke`, { body: { reason }, csrfToken }),
  myCourseCertificates: (courseId: string) => apiRequest<MyCourseCertificates>('GET', `${course(courseId)}/certificates/mine`),
  myCertificates: () => apiRequest<MyCertificates>('GET', '/me/certificates'),
  getCertificate: (certificateId: string) => apiRequest<Certificate>('GET', `/certificates/${certificateId}`),
  listAllCertificates: (filter: { status?: 'issued' | 'revoked'; cursor?: string } = {}) => {
    const params = new URLSearchParams({ limit: '100', ...(filter.status ? { status: filter.status } : {}), ...(filter.cursor ? { cursor: filter.cursor } : {}) });
    return apiRequest<CertificatePage>('GET', `/certificates?${params.toString()}`);
  },
  verifyCertificate: (token: string) => apiRequest<CertificateVerification>('GET', `/certificates/verify/${encodeURIComponent(token)}`),
  /** The certificate PDF as a Blob (same-origin, with the session cookie); the browser saves it. */
  downloadCertificatePdf: async (certificateId: string) => {
    const response = await fetch(`${API_BASE}/certificates/${certificateId}/pdf`, { credentials: 'same-origin', headers: { accept: 'application/pdf' } });
    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      throw new ApiError(response.status, problem && typeof problem === 'object' && 'status' in problem ? problem : null);
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    return { blob: await response.blob(), fileName: /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'certificate.pdf' };
  },

  // Announcements and academic calendar (AP-025): visibility, scheduling and read state are decided by the API.
  listCourseAnnouncements: (courseId: string, filter: { status?: 'all' | AnnouncementStatus; cursor?: string | null } = {}) =>
    apiRequest<AnnouncementPage>('GET', `${course(courseId)}/announcements?${rangeParams({ limit: '50', status: filter.status, cursor: filter.cursor })}`),
  listInstitutionAnnouncements: (filter: { status?: 'all' | AnnouncementStatus; cursor?: string | null } = {}) =>
    apiRequest<AnnouncementPage>('GET', `/announcements?${rangeParams({ limit: '50', status: filter.status, cursor: filter.cursor })}`),
  myAnnouncements: (page: { limit?: number; cursor?: string | null } = {}) =>
    apiRequest<AnnouncementPage>('GET', `/me/announcements?${rangeParams({ limit: String(page.limit ?? 20), cursor: page.cursor })}`),
  myUnreadCount: () => apiRequest<UnreadCount>('GET', '/me/announcements/unread-count'),
  getAnnouncement: (announcementId: string) => apiRequest<Announcement>('GET', `/announcements/${encodeURIComponent(announcementId)}`),
  markAnnouncementRead: (announcementId: string, csrfToken: string) =>
    apiRequest<void>('PUT', `/announcements/${encodeURIComponent(announcementId)}/read`, { csrfToken }),
  createCourseAnnouncement: (courseId: string, body: AnnouncementInput, csrfToken: string) =>
    apiRequest<Announcement>('POST', `${course(courseId)}/announcements`, { body, csrfToken }),
  createInstitutionAnnouncement: (body: AnnouncementInput, csrfToken: string) => apiRequest<Announcement>('POST', '/announcements', { body, csrfToken }),
  updateAnnouncement: (announcementId: string, body: AnnouncementUpdate, csrfToken: string) =>
    apiRequest<Announcement>('PUT', `/announcements/${encodeURIComponent(announcementId)}`, { body, csrfToken }),
  publishAnnouncement: (announcementId: string, publishAt: string | null, csrfToken: string) =>
    apiRequest<Announcement>('POST', `/announcements/${encodeURIComponent(announcementId)}/publish`, { body: publishAt ? { publishAt } : {}, csrfToken }),
  unscheduleAnnouncement: (announcementId: string, csrfToken: string) =>
    apiRequest<Announcement>('POST', `/announcements/${encodeURIComponent(announcementId)}/unschedule`, { csrfToken }),
  archiveAnnouncement: (announcementId: string, csrfToken: string) =>
    apiRequest<Announcement>('POST', `/announcements/${encodeURIComponent(announcementId)}/archive`, { csrfToken }),
  courseCalendar: (courseId: string, range: { from: string; to: string }) =>
    apiRequest<Calendar>('GET', `${course(courseId)}/calendar?${rangeParams(range)}`),
  myCalendar: (range: { from: string; to: string; courseId?: string | null }) => apiRequest<Calendar>('GET', `/me/calendar?${rangeParams(range)}`),
  institutionEvents: (range: { from: string; to: string }) => apiRequest<CalendarEventList>('GET', `/calendar/events?${rangeParams(range)}`),
  createCourseEvent: (courseId: string, body: CalendarEventInput, csrfToken: string) =>
    apiRequest<CalendarEvent>('POST', `${course(courseId)}/calendar/events`, { body, csrfToken }),
  createInstitutionEvent: (body: CalendarEventInput, csrfToken: string) => apiRequest<CalendarEvent>('POST', '/calendar/events', { body, csrfToken }),
  updateEvent: (eventId: string, body: CalendarEventInput, csrfToken: string) =>
    apiRequest<CalendarEvent>('PUT', `/calendar/events/${encodeURIComponent(eventId)}`, { body, csrfToken }),
  cancelEvent: (eventId: string, csrfToken: string) => apiRequest<CalendarEvent>('POST', `/calendar/events/${encodeURIComponent(eventId)}/cancel`, { csrfToken }),
  deleteEvent: (eventId: string, csrfToken: string) => apiRequest<void>('DELETE', `/calendar/events/${encodeURIComponent(eventId)}`, { csrfToken }),

  // Messaging and notifications (AP-026): who may read or write is decided by the API on every request.
  messagingSummary: () => apiRequest<MessagingSummary>('GET', '/me/messaging/summary'),
  myConversations: (cursor?: string | null) => apiRequest<ConversationPage>('GET', `/me/conversations?${rangeParams({ limit: '50', cursor })}`),
  courseMessaging: (courseId: string) => apiRequest<CourseMessaging>('GET', `${course(courseId)}/messaging`),
  openDirectConversation: (courseId: string, recipientUserId: string, csrfToken: string) =>
    apiRequest<Conversation>('POST', `${course(courseId)}/conversations`, { body: { recipientUserId }, csrfToken }),
  openCourseConversation: (courseId: string, csrfToken: string) => apiRequest<Conversation>('POST', `${course(courseId)}/course-conversation`, { csrfToken }),
  getConversation: (conversationId: string) => apiRequest<Conversation>('GET', `/conversations/${encodeURIComponent(conversationId)}`),
  listMessages: (conversationId: string, page: { before?: number; after?: number; limit?: number } = {}) =>
    apiRequest<MessagePage>(
      'GET',
      `/conversations/${encodeURIComponent(conversationId)}/messages?${rangeParams({
        limit: String(page.limit ?? 30),
        before: page.before === undefined ? undefined : String(page.before),
        after: page.after === undefined ? undefined : String(page.after),
      })}`,
    ),
  sendMessage: (conversationId: string, body: string, clientMessageId: string, csrfToken: string) =>
    apiRequest<Message>('POST', `/conversations/${encodeURIComponent(conversationId)}/messages`, { body: { body, clientMessageId }, csrfToken }),
  markConversationRead: (conversationId: string, upToSeq: number, csrfToken: string) =>
    apiRequest<void>('PUT', `/conversations/${encodeURIComponent(conversationId)}/read`, { body: { upToSeq }, csrfToken }),
  hideMessage: (conversationId: string, messageId: string, csrfToken: string) =>
    apiRequest<Message>('POST', `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/hide`, { csrfToken }),
  setConversationLock: (conversationId: string, locked: boolean, csrfToken: string) =>
    apiRequest<LockResult>('POST', `/conversations/${encodeURIComponent(conversationId)}/${locked ? 'lock' : 'unlock'}`, { csrfToken }),
  adminCourseConversations: () => apiRequest<AdminCourseConversationList>('GET', '/admin/messaging/courses'),
  myNotifications: (filter: { cursor?: string | null; unread?: boolean } = {}) =>
    apiRequest<NotificationPage>('GET', `/me/notifications?${rangeParams({ limit: '20', cursor: filter.cursor, unread: filter.unread ? 'true' : undefined })}`),
  markNotificationRead: (notificationId: string, csrfToken: string) =>
    apiRequest<void>('PUT', `/me/notifications/${encodeURIComponent(notificationId)}/read`, { csrfToken }),
  markAllNotificationsRead: (csrfToken: string) => apiRequest<{ updated: number }>('POST', '/me/notifications/read-all', { csrfToken }),

  // Course discussion forums (AP-027): access, visibility, edit windows and moderation are decided by the API.
  forumTopics: (courseId: string, filter: { cursor?: string | null; q?: string | null } = {}) =>
    apiRequest<ForumTopicPage>('GET', `${course(courseId)}/forum/topics?${rangeParams({ limit: '20', cursor: filter.cursor, q: filter.q })}`),
  createForumTopic: (courseId: string, body: ForumTopicInput, csrfToken: string) =>
    apiRequest<ForumTopic>('POST', `${course(courseId)}/forum/topics`, { body, csrfToken }),
  getForumTopic: (topicId: string) => apiRequest<ForumTopic>('GET', `/forum/topics/${encodeURIComponent(topicId)}`),
  updateForumTopic: (topicId: string, body: { title?: string; body?: string }, csrfToken: string) =>
    apiRequest<ForumTopic>('PATCH', `/forum/topics/${encodeURIComponent(topicId)}`, { body, csrfToken }),
  moderateForumTopic: (topicId: string, action: ForumTopicAction, csrfToken: string) =>
    apiRequest<ForumTopic>('POST', `/forum/topics/${encodeURIComponent(topicId)}/moderation`, { body: { action }, csrfToken }),
  forumPosts: (topicId: string, after?: number | null) =>
    apiRequest<ForumPostPage>('GET', `/forum/topics/${encodeURIComponent(topicId)}/posts?${rangeParams({ limit: '20', after: after == null ? undefined : String(after) })}`),
  createForumPost: (topicId: string, body: { body: string; clientRequestId: string; parentPostId?: string }, csrfToken: string) =>
    apiRequest<ForumPost>('POST', `/forum/topics/${encodeURIComponent(topicId)}/posts`, { body, csrfToken }),
  updateForumPost: (postId: string, body: string, csrfToken: string) =>
    apiRequest<ForumPost>('PATCH', `/forum/posts/${encodeURIComponent(postId)}`, { body: { body }, csrfToken }),
  moderateForumPost: (postId: string, action: ForumPostAction, csrfToken: string) =>
    apiRequest<ForumPost>('POST', `/forum/posts/${encodeURIComponent(postId)}/moderation`, { body: { action }, csrfToken }),
  adminForumCourses: () => apiRequest<AdminForumCourseList>('GET', '/admin/forums/courses'),

  // Advanced gradebook (AP-023): every calculation and permission check happens in the API.
  getGradingPolicy: (courseId: string) => apiRequest<GradingPolicy>('GET', `${course(courseId)}/grading-policy`),
  saveGradingPolicy: (courseId: string, body: GradingPolicyInput, csrfToken: string) =>
    apiRequest<GradingPolicy>('PUT', `${course(courseId)}/grading-policy`, { body, csrfToken }),
  getStudentGradebook: (courseId: string, userId: string) => apiRequest<StudentGradebook>('GET', `${course(courseId)}/gradebook/students/${userId}`),
  releaseSelectedGrades: (courseId: string, body: GradeSelectionRelease, csrfToken: string) =>
    apiRequest<GradeSelectionReleaseResult>('POST', `${course(courseId)}/grades/release`, { body, csrfToken }),
  /** The CSV as a Blob (same-origin, sent with the session cookie); the browser saves it as a file. */
  exportGradebookCsv: async (courseId: string) => {
    const response = await fetch(`${API_BASE}${course(courseId)}/gradebook/export.csv`, { credentials: 'same-origin', headers: { accept: 'text/csv' } });
    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      throw new ApiError(response.status, problem && typeof problem === 'object' && 'status' in problem ? problem : null);
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'gradebook.csv';
    return { blob: await response.blob(), fileName };
  },

  // Documents: uploaded and validated by the API, which extracts the text and creates mock summaries.
  uploadDocument: (courseId: string, sectionId: string, file: File, title: string, csrfToken: string) => {
    const form = new FormData();
    // The title must precede the file part.
    if (title.trim()) form.append('title', title.trim());
    form.append('file', file);
    return apiUpload<DocumentDetail>(`${course(courseId)}/sections/${encodeURIComponent(sectionId)}/documents`, form, csrfToken);
  },
  getDocument: (courseId: string, activityId: string) => apiRequest<DocumentDetail>('GET', `${activity(courseId, activityId)}/document`),
  refreshDocumentSummary: (courseId: string, activityId: string, csrfToken: string) =>
    apiRequest<DocumentDetail>('POST', `${activity(courseId, activityId)}/document/summaries`, { csrfToken }),
  /** Same-origin download link; the API checks the session and course access before sending the file. */
  documentFileHref: (courseId: string, activityId: string) => `${API_BASE}${activity(courseId, activityId)}/document/file`,

  // Course tutor (local mock provider on the API; nothing is sent to external services).
  askTutor: (courseId: string, question: string, language: TutorLanguage, csrfToken: string) =>
    apiRequest<TutorMessageResponse>('POST', `${course(courseId)}/tutor/messages`, { body: { question, language }, csrfToken }),
  tutorPractice: (courseId: string, language: TutorLanguage, topic: string | null, csrfToken: string) =>
    apiRequest<TutorPracticeResponse>('POST', `${course(courseId)}/tutor/practice`, { body: { language, ...(topic ? { topic } : {}) }, csrfToken }),
  tutorUsage: (courseId: string) => apiRequest<TutorUsage>('GET', `${course(courseId)}/tutor/usage`),

  // Learning progress: every figure is calculated by the API from stored records (never in the browser).
  myProgress: () => apiRequest<MyProgressList>('GET', '/me/progress'),
  courseProgress: (courseId: string) => apiRequest<CourseProgress>('GET', `${course(courseId)}/progress`),
  sectionProgress: (courseId: string, sectionId: string) =>
    apiRequest<SectionProgress>('GET', `${course(courseId)}/sections/${encodeURIComponent(sectionId)}/progress`),
  markComplete: (courseId: string, activityId: string, csrfToken: string) =>
    apiRequest<ActivityCompletion>('PUT', `${activity(courseId, activityId)}/completion`, { csrfToken }),
  markIncomplete: (courseId: string, activityId: string, csrfToken: string) =>
    apiRequest<ActivityCompletion>('DELETE', `${activity(courseId, activityId)}/completion`, { csrfToken }),
  studentProgress: (courseId: string, page?: PageRequest) =>
    apiRequest<StudentProgressPage>('GET', withPage(`${course(courseId)}/progress/students`, page)),
  sectionPrerequisites: (courseId: string) => apiRequest<SectionPrerequisiteList>('GET', `${course(courseId)}/section-prerequisites`),
  setSectionPrerequisites: (courseId: string, sectionId: string, requiredSectionIds: string[], csrfToken: string) =>
    apiRequest<SectionPrerequisites>('PUT', `${course(courseId)}/sections/${encodeURIComponent(sectionId)}/prerequisites`, {
      body: { requiredSectionIds },
      csrfToken,
    }),

  // Assessment controls (AP-022).
  quizFeedback: (courseId: string, attemptId: string) => apiRequest<QuizFeedback>('GET', `${attempt(courseId, attemptId)}/feedback`),
  importQuizQuestions: (courseId: string, quizId: string, sourceActivityId: string, csrfToken: string) =>
    apiRequest<QuizQuestionList>('POST', `${activity(courseId, quizId)}/questions/import`, { body: { sourceActivityId }, csrfToken }),

  // Learning resources: folders, ordering and visibility (the API enforces every rule).
  listResourceFolders: (courseId: string, sectionId: string) =>
    apiRequest<ResourceFolderList>('GET', `${course(courseId)}/sections/${encodeURIComponent(sectionId)}/resource-folders`),
  createResourceFolder: (courseId: string, sectionId: string, title: string, csrfToken: string) =>
    apiRequest<ResourceFolder>('POST', `${course(courseId)}/sections/${encodeURIComponent(sectionId)}/resource-folders`, { body: { title }, csrfToken }),
  renameResourceFolder: (courseId: string, folderId: string, title: string, csrfToken: string) =>
    apiRequest<ResourceFolder>('PUT', `${course(courseId)}/resource-folders/${encodeURIComponent(folderId)}`, { body: { title }, csrfToken }),
  deleteResourceFolder: (courseId: string, folderId: string, csrfToken: string) =>
    apiRequest<void>('DELETE', `${course(courseId)}/resource-folders/${encodeURIComponent(folderId)}`, { csrfToken }),
  orderResourceFolders: (courseId: string, sectionId: string, folderIds: string[], csrfToken: string) =>
    apiRequest<ResourceFolderList>('PUT', `${course(courseId)}/sections/${encodeURIComponent(sectionId)}/resource-folders/order`, { body: { folderIds }, csrfToken }),
  orderActivities: (courseId: string, sectionId: string, activityIds: string[], csrfToken: string) =>
    apiRequest<{ activityIds: string[] }>('PUT', `${course(courseId)}/sections/${encodeURIComponent(sectionId)}/activities/order`, { body: { activityIds }, csrfToken }),
  organizeActivity: (courseId: string, activityId: string, body: ActivityOrganization, csrfToken: string) =>
    apiRequest<ActivityOrganizationResult>('PUT', `${activity(courseId, activityId)}/organization`, { body, csrfToken }),
};
