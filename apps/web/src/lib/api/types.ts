import type { components } from '@academiapath/contract/types';

/**
 * API types generated from packages/contract/openapi.yaml (regenerate with `pnpm contract:types`).
 * Only aliases live here; never hand-write API shapes in the web app.
 */
type Schemas = components['schemas'];

export type ProblemDetails = Schemas['ProblemDetails'];
export type CurrentUser = Schemas['CurrentUser'];
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
export type ActivityPage = Schemas['ActivityPage'];
export type ActivityCreate = Schemas['ActivityCreate'];
export type ActivityUpdate = Schemas['ActivityUpdate'];
export type ActivityReviewDecision = Schemas['ActivityReviewDecision'];
