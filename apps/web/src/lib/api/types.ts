import type { components } from '@academiapath/contract/types';

/**
 * API types generated from packages/contract/openapi.yaml (regenerate with `pnpm contract:types`).
 * Only aliases live here; never hand-write API shapes in the web app.
 */
type Schemas = components['schemas'];

export type ProblemDetails = Schemas['ProblemDetails'];
export type CurrentUser = Schemas['CurrentUser'];
export type CourseEmailRecipients = Schemas['CourseEmailRecipients'];
export type LoginRequest = Schemas['LoginRequest'];
export type LoginResponse = Schemas['LoginResponse'];
export type MeResponse = Schemas['MeResponse'];
export type CsrfTokenResponse = Schemas['CsrfTokenResponse'];

export type CourseRole = Schemas['CourseRole'];
export type CourseStatus = Schemas['CourseStatus'];
export type Course = Schemas['Course'];
export type CoursePage = Schemas['CoursePage'];
export type CourseCreate = Schemas['CourseCreate'];
export type Section = Schemas['Section'];
export type SectionPage = Schemas['SectionPage'];

export type Program = Schemas['Program'];
export type ProgramCreate = Schemas['ProgramCreate'];
export type ProgramPage = Schemas['ProgramPage'];
export type Term = Schemas['Term'];
export type TermCreate = Schemas['TermCreate'];
export type TermPage = Schemas['TermPage'];
export type CourseTemplate = Schemas['CourseTemplate'];
export type CourseTemplateCreate = Schemas['CourseTemplateCreate'];
export type CourseTemplateVersion = Schemas['CourseTemplateVersion'];
export type CourseTemplatePage = Schemas['CourseTemplatePage'];
export type Enrollment = Schemas['Enrollment'];
export type EnrollmentCreate = Schemas['EnrollmentCreate'];

export type ReviewStatus = Schemas['ReviewStatus'];
export type Activity = Schemas['Activity'];
export type QualityReport = Schemas['QualityReport'];
export type QualityFinding = Schemas['QualityFinding'];
export type QualityIssueCode = Schemas['QualityIssueCode'];
export type ActivityPage = Schemas['ActivityPage'];
export type ActivityCreate = Schemas['ActivityCreate'];
export type ActivityUpdate = Schemas['ActivityUpdate'];
export type ActivityReviewDecision = Schemas['ActivityReviewDecision'];

export type QuizContent = Schemas['QuizContent'];
export type QuizQuestion = Schemas['QuizQuestion'];
export type QuizQuestionInput = Schemas['QuizQuestionInput'];
export type QuizQuestionList = Schemas['QuizQuestionList'];
export type QuizAnswersSave = Schemas['QuizAnswersSave'];
export type QuizAttemptSubmit = Schemas['QuizAttemptSubmit'];
export type StudentQuizAttempt = Schemas['StudentQuizAttempt'];
export type StudentQuizAttemptSummary = Schemas['StudentQuizAttemptSummary'];
export type QuizResultPage = Schemas['QuizResultPage'];
export type QuizAttemptResult = Schemas['QuizAttemptResult'];
export type QuizQuestionType = Schemas['QuizQuestionType'];
export type QuizResult = Schemas['QuizResult'];

export type AssignmentContent = Schemas['AssignmentContent'];
export type RubricCriterion = Schemas['RubricCriterion'];
export type StudentAssignmentStatus = Schemas['StudentAssignmentStatus'];
export type StudentAssignmentSubmission = Schemas['StudentAssignmentSubmission'];
export type AssignmentSubmissionSummary = Schemas['AssignmentSubmissionSummary'];
export type AssignmentSubmissionPage = Schemas['AssignmentSubmissionPage'];
export type AssignmentSubmissionDetail = Schemas['AssignmentSubmissionDetail'];
export type AssignmentGradeInput = Schemas['AssignmentGradeInput'];
export type GradeReleaseResult = Schemas['GradeReleaseResult'];
export type GradeStatus = Schemas['GradeStatus'];
export type ReleasedGrade = Schemas['ReleasedGrade'];
export type CourseTotal = Schemas['CourseTotal'];
export type Gradebook = Schemas['Gradebook'];
export type StudentGrades = Schemas['StudentGrades'];
export type CourseGrade = Schemas['CourseGrade'];
export type GradingPolicy = Schemas['GradingPolicy'];
export type GradingPolicyInput = Schemas['GradingPolicyInput'];
export type StudentGradebook = Schemas['StudentGradebook'];
export type GradeSelectionRelease = Schemas['GradeSelectionRelease'];
export type GradeSelectionReleaseResult = Schemas['GradeSelectionReleaseResult'];
export type CertificatePolicy = Schemas['CertificatePolicy'];
export type CertificatePolicyInput = Schemas['CertificatePolicyInput'];
export type CertificateEligibility = Schemas['CertificateEligibility'];
export type CertificateRequirement = Schemas['CertificateRequirement'];
export type Certificate = Schemas['Certificate'];
export type CertificateList = Schemas['CertificateList'];
export type CertificatePage = Schemas['CertificatePage'];
export type CourseCertificateEligibility = Schemas['CourseCertificateEligibility'];
export type MyCourseCertificates = Schemas['MyCourseCertificates'];
export type MyCertificates = Schemas['MyCertificates'];
export type CertificateVerification = Schemas['CertificateVerification'];

export type Announcement = Schemas['Announcement'];
export type AnnouncementPage = Schemas['AnnouncementPage'];
export type AnnouncementInput = Schemas['AnnouncementInput'];
export type AnnouncementUpdate = Schemas['AnnouncementUpdate'];
export type AnnouncementStatus = Announcement['status'];
export type UnreadCount = Schemas['UnreadCount'];
export type CalendarEvent = Schemas['CalendarEvent'];
export type CalendarEventInput = Schemas['CalendarEventInput'];
export type CalendarEventList = Schemas['CalendarEventList'];
export type CalendarDueDate = Schemas['CalendarDueDate'];
export type Calendar = Schemas['Calendar'];

export type TutorLanguage = Schemas['TutorLanguage'];
export type TutorGuideAction = Schemas['TutorGuideAction'];
export type TutorSuggestedAction = Schemas['TutorSuggestedAction'];
export type TutorGuideBlock = Schemas['TutorGuideBlock'];
export type TutorGuideReference = Schemas['TutorGuideReference'];
export type TutorGuideResponse = Schemas['TutorGuideResponse'];
export type TutorPracticeCheckResponse = Schemas['TutorPracticeCheckResponse'];

export type DocumentFormat = Schemas['DocumentFormat'];
export type DocumentContent = Schemas['DocumentContent'];
export type DocumentDetail = Schemas['DocumentDetail'];
export type DocumentStudyBrief = Schemas['DocumentStudyBrief'];
export type StudyBriefText = Schemas['StudyBriefText'];
export type StudyBriefReference = Schemas['StudyBriefReference'];
export type DocumentSegment = Schemas['DocumentSegment'];
export type DocumentSummary = Schemas['DocumentSummary'];

export type ProgramUpdate = Schemas['ProgramUpdate'];
export type TermUpdate = Schemas['TermUpdate'];
export type CourseTemplateDetail = Schemas['CourseTemplateDetail'];
export type EnrollmentPage = Schemas['EnrollmentPage'];

export type SystemRole = Schemas['SystemRole'];
export type UserSummary = Schemas['UserSummary'];
export type UserPage = Schemas['UserPage'];
export type UserDetail = Schemas['UserDetail'];
export type UserEnrollment = Schemas['UserEnrollment'];
export type UserCreate = Schemas['UserCreate'];
export type UserUpdate = Schemas['UserUpdate'];
export type UserCreateResult = Schemas['UserCreateResult'];
export type AccountInvitation = Schemas['AccountInvitation'];
export type ActivationPreview = Schemas['ActivationPreview'];
export type EnrollmentUpdate = Schemas['EnrollmentUpdate'];
export type EnrollmentImportResult = Schemas['EnrollmentImportResult'];
export type EnrollmentImportRow = Schemas['EnrollmentImportRow'];

export type CourseUpdate = Schemas['CourseUpdate'];
export type CourseLifecycle = Schemas['CourseLifecycle'];
export type SectionCreate = Schemas['SectionCreate'];
export type SectionUpdate = Schemas['SectionUpdate'];
export type SectionList = Schemas['SectionList'];

export type ManagedProgramList = Schemas['ManagedProgramList'];
export type ManagedProgram = Schemas['ManagedProgramList']['items'][number];
export type ProgramManager = Schemas['ProgramManager'];
export type ProgramManagerList = Schemas['ProgramManagerList'];
export type CourseTemplateVersionList = Schemas['CourseTemplateVersionList'];
export type ProgressState = Schemas['ProgressState'];
export type CourseProgress = Schemas['CourseProgress'];
export type SectionProgressSummary = Schemas['SectionProgressSummary'];
export type SectionProgress = Schemas['SectionProgress'];
export type ActivityProgress = Schemas['ActivityProgress'];
export type ActivityCompletion = Schemas['ActivityCompletion'];
export type MyProgressList = Schemas['MyProgressList'];
export type StudentProgressPage = Schemas['StudentProgressPage'];
export type SectionPrerequisites = Schemas['SectionPrerequisites'];
export type SectionPrerequisiteList = Schemas['SectionPrerequisiteList'];

export type ResourceKind = Schemas['ResourceKind'];
export type ResourceFolder = Schemas['ResourceFolder'];
export type ResourceFolderList = Schemas['ResourceFolderList'];
export type ActivityOrganization = Schemas['ActivityOrganization'];
export type ActivityOrganizationResult = Schemas['ActivityOrganizationResult'];

export type QuizFeedback = Schemas['QuizFeedback'];

export type Conversation = Schemas['Conversation'];
export type ConversationPage = Schemas['ConversationPage'];
export type CourseMessaging = Schemas['CourseMessaging'];
export type Message = Schemas['Message'];
export type MessagePage = Schemas['MessagePage'];
export type MessagingSummary = Schemas['MessagingSummary'];
export type AppNotification = Schemas['Notification'];
export type NotificationPage = Schemas['NotificationPage'];
export type AdminCourseConversationList = Schemas['AdminCourseConversationList'];
export type LockResult = Schemas['LockResult'];

export type ForumViewer = Schemas['ForumViewer'];
export type ForumTopicSummary = Schemas['ForumTopicSummary'];
export type ForumTopicPage = Schemas['ForumTopicPage'];
export type ForumTopic = Schemas['ForumTopic'];
export type ForumTopicInput = Schemas['ForumTopicInput'];
export type ForumPost = Schemas['ForumPost'];
export type ForumThreadItem = Schemas['ForumThreadItem'];
export type ForumPostPage = Schemas['ForumPostPage'];
export type ForumTopicAction = Schemas['ForumTopicModeration']['action'];
export type ForumPostAction = Schemas['ForumPostModeration']['action'];
export type AdminForumCourseList = Schemas['AdminForumCourseList'];

export type GroupSummary = Schemas['GroupSummary'];
export type CourseGroupList = Schemas['CourseGroupList'];
export type MyGroupList = Schemas['MyGroupList'];
export type GroupDetail = Schemas['GroupDetail'];
export type GroupInput = Schemas['GroupInput'];
export type GroupUpdate = Schemas['GroupUpdate'];
export type GroupMemberAddResult = Schemas['GroupMemberAddResult'];
export type AdminGroupOverview = Schemas['AdminGroupOverview'];
