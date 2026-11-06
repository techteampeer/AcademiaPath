import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { recordAudit } from '../audit.js';
import { getCourseAccess } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import type { Database } from '../db/client.js';
import { withUniqueConflict } from '../db/errors.js';
import {
  activities,
  courseTemplateVersions,
  courseTemplates,
  courses,
  enrollments,
  sections,
  terms,
  type CourseRole,
} from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';
import {
  courseLifecycleSchema,
  courseTransitionSchema,
  courseUpdateSchema,
  sectionCreateSchema,
  sectionListSchema,
  sectionOrderSchema,
  sectionParamsSchema,
  sectionUpdateSchema,
} from './course-lifecycle-schemas.js';
import { courseIdParamsSchema, courseSchema, courseSectionSchema } from './course-schemas.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type CourseParams = { id: string };
type SectionParams = { id: string; sectionId: string };
type CourseRecord = typeof courses.$inferSelect;
type Transition = 'publish' | 'unpublish';

const courseNotFound = () => new ApiProblem(404, 'NOT_FOUND', 'Course not found.');
const sectionNotFound = () => new ApiProblem(404, 'NOT_FOUND', 'Section not found.');
const versionConflict = () =>
  new ApiProblem(409, 'COURSE_VERSION_CONFLICT', 'The course was changed by someone else in the meantime. Reload it and try again.');

/** Explicit, validated status transitions. `archived` has none here (it is not reachable through this API). */
const TRANSITIONS: Record<Transition, { from: CourseRecord['status']; to: CourseRecord['status'] }> = {
  publish: { from: 'draft', to: 'published' },
  unpublish: { from: 'published', to: 'draft' },
};
const allowedTransitions = (status: CourseRecord['status']) =>
  (Object.keys(TRANSITIONS) as Transition[]).filter((name) => TRANSITIONS[name].from === status);

const sectionColumns = { id: sections.id, title: sections.title, summary: sections.summary, position: sections.position, isVisible: sections.isVisible };

/** Optional text: trimmed, empty becomes null. */
const optionalText = (value: string | null | undefined) => (value === undefined ? undefined : value === null || !value.trim() ? null : value.trim());

/**
 * Course lifecycle administration: details, explicit publish/unpublish transitions and section
 * structure. Administrators only (course roles, including design team and instructors, never manage
 * offerings). Every change locks the course row, so changes to one course are serialized; details and
 * status changes also require the `version` the caller saw. Subject templates are never modified.
 */
export const courseLifecycleRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const adminRead = { preValidation: [app.requireAuth, app.requireAdministrator] };
  const adminWrite = { preValidation: [app.requireAuth, app.requireCsrf, app.requireAdministrator] };

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  async function lockCourse(tx: Tx, id: string): Promise<CourseRecord> {
    const [course] = await tx.select().from(courses).where(eq(courses.id, id)).for('update');
    if (!course) throw courseNotFound();
    return course;
  }

  /** The caller's own course role (administrators may also hold one), as returned by GET /courses/:id. */
  async function viewerRole(request: Parameters<typeof getAuth>[0], courseId: string): Promise<CourseRole | null> {
    return (await getCourseAccess(db, getAuth(request).user, courseId))?.viewerRole ?? null;
  }

  // ---- Overview ----

  app.get<{ Params: CourseParams }>(
    '/courses/:id/lifecycle',
    { ...adminRead, schema: { params: courseIdParamsSchema, response: { 200: courseLifecycleSchema } } },
    async (request) => {
      const [course] = await db.select().from(courses).where(eq(courses.id, request.params.id));
      if (!course) throw courseNotFound();
      const [term] = await db
        .select({ id: terms.id, code: terms.code, name: terms.name, startsOn: terms.startsOn, endsOn: terms.endsOn })
        .from(terms)
        .where(eq(terms.id, course.termId));
      const [template] = course.templateVersionId
        ? await db
            .select({ id: courseTemplates.id, code: courseTemplates.code, title: courseTemplateVersions.title, version: courseTemplateVersions.version })
            .from(courseTemplateVersions)
            .innerJoin(courseTemplates, eq(courseTemplates.id, courseTemplateVersions.templateId))
            .where(eq(courseTemplateVersions.id, course.templateVersionId))
        : [];
      const approvedAndVisible = sql`${activities.approvedConfig} IS NOT NULL AND ${activities.isVisible}`;
      const sectionRows = await db
        .select({
          ...sectionColumns,
          activityCount: sql<number>`count(${activities.id})::int`,
          studentVisibleActivityCount: sql<number>`(count(${activities.id}) FILTER (WHERE ${approvedAndVisible}))::int`,
          unapproved: sql<number>`(count(${activities.id}) FILTER (WHERE ${activities.approvedConfig} IS NULL))::int`,
          awaitingReview: sql<number>`(count(${activities.id}) FILTER (WHERE ${activities.reviewStatus} = 'submitted'))::int`,
        })
        .from(sections)
        .leftJoin(activities, eq(activities.sectionId, sections.id))
        .where(eq(sections.courseId, course.id))
        .groupBy(sections.id)
        .orderBy(asc(sections.position), asc(sections.id));
      const roleRows = await db
        .select({ role: enrollments.role, status: enrollments.status, count: sql<number>`count(*)::int` })
        .from(enrollments)
        .where(eq(enrollments.courseId, course.id))
        .groupBy(enrollments.role, enrollments.status);
      const roles: CourseRole[] = ['design_team', 'instructor', 'non_editing_instructor', 'student'];

      return {
        course: { ...course, viewerRole: await viewerRole(request, course.id) },
        term: term!,
        template: template ?? null,
        sections: sectionRows.map(({ unapproved: _u, awaitingReview: _a, ...section }) => section),
        enrollmentCounts: roles.map((role) => ({
          role,
          active: roleRows.find((r) => r.role === role && r.status === 'active')?.count ?? 0,
          inactive: roleRows.find((r) => r.role === role && r.status === 'inactive')?.count ?? 0,
        })),
        studentVisibleActivityCount: sectionRows.filter((s) => s.isVisible).reduce((sum, s) => sum + s.studentVisibleActivityCount, 0),
        unapprovedActivityCount: sectionRows.reduce((sum, s) => sum + s.unapproved, 0),
        awaitingReviewCount: sectionRows.reduce((sum, s) => sum + s.awaitingReview, 0),
        allowedTransitions: allowedTransitions(course.status),
      };
    },
  );

  // ---- Details ----

  app.put<{ Params: CourseParams; Body: { version: number; title?: string; code?: string; description?: string | null } }>(
    '/courses/:id',
    { ...adminWrite, schema: { params: courseIdParamsSchema, body: courseUpdateSchema, response: { 200: courseSchema } } },
    async (request) => {
      const { version, ...body } = request.body;
      const next: Partial<Pick<CourseRecord, 'title' | 'code' | 'description'>> = {
        ...(body.title !== undefined ? { title: body.title.trim() } : {}),
        ...(body.code !== undefined ? { code: body.code } : {}),
        ...(body.description !== undefined ? { description: optionalText(body.description) } : {}),
      };
      const updated = await db.transaction(async (tx) => {
        const course = await lockCourse(tx, request.params.id);
        if (course.version !== version) throw versionConflict();
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(next) as Array<[keyof typeof next, string | null]>) {
          if (course[key] !== value) {
            before[key] = course[key];
            after[key] = value;
          }
        }
        if (Object.keys(after).length === 0) return course;
        // A published (or formerly published) offering is known by its code; only drafts may change it.
        if ('code' in after && course.status !== 'draft') {
          throw new ApiProblem(409, 'COURSE_CODE_LOCKED', 'The code can only be changed while the course is a draft.');
        }
        const [row] = await withUniqueConflict(
          () =>
            tx
              .update(courses)
              .set({ ...after, version: course.version + 1 })
              .where(and(eq(courses.id, course.id), eq(courses.version, version)))
              .returning(),
          'courses_term_id_code_unique',
          'COURSE_CODE_TAKEN',
          'A course with this code already exists in the term.',
        );
        if (!row) throw versionConflict();
        await recordAudit(tx, request, {
          action: 'course.updated',
          entityType: 'course',
          entityId: course.id,
          before: { ...before, version: course.version },
          after: { ...after, version: row.version },
        });
        return row;
      });
      return { ...updated, viewerRole: await viewerRole(request, updated.id) };
    },
  );

  // ---- Status transitions ----

  for (const name of ['publish', 'unpublish'] as const) {
    app.post<{ Params: CourseParams; Body: { version: number } }>(
      `/courses/:id/${name}`,
      { ...adminWrite, schema: { params: courseIdParamsSchema, body: courseTransitionSchema, response: { 200: courseSchema } } },
      async (request) => {
        const { from, to } = TRANSITIONS[name];
        const updated = await db.transaction(async (tx) => {
          const course = await lockCourse(tx, request.params.id);
          if (course.version !== request.body.version) throw versionConflict();
          if (course.status !== from) {
            throw new ApiProblem(409, 'INVALID_COURSE_TRANSITION', `A ${course.status} course cannot be ${name === 'publish' ? 'published' : 'unpublished'}.`);
          }
          // Only the status changes: content approval, section visibility and grade release are untouched.
          const [row] = await tx
            .update(courses)
            .set({ status: to, version: course.version + 1 })
            .where(and(eq(courses.id, course.id), eq(courses.version, course.version)))
            .returning();
          if (!row) throw versionConflict();
          await recordAudit(tx, request, {
            action: name === 'publish' ? 'course.published' : 'course.unpublished',
            entityType: 'course',
            entityId: course.id,
            before: { status: course.status, version: course.version },
            after: { status: row.status, version: row.version },
          });
          return row;
        });
        return { ...updated, viewerRole: await viewerRole(request, updated.id) };
      },
    );
  }

  // ---- Sections (this offering only; the template is never touched) ----

  app.post<{ Params: CourseParams; Body: { title: string; summary?: string | null; isVisible: boolean } }>(
    '/courses/:id/sections',
    { ...adminWrite, schema: { params: courseIdParamsSchema, body: sectionCreateSchema, response: { 201: courseSectionSchema } } },
    async (request, reply) => {
      const section = await db.transaction(async (tx) => {
        const course = await lockCourse(tx, request.params.id);
        const [last] = await tx
          .select({ next: sql<number>`coalesce(max(${sections.position}) + 1, 0)::int` })
          .from(sections)
          .where(eq(sections.courseId, course.id));
        const [created] = await tx
          .insert(sections)
          .values({
            courseId: course.id,
            title: request.body.title.trim(),
            summary: optionalText(request.body.summary) ?? null,
            position: last?.next ?? 0,
            isVisible: request.body.isVisible,
          })
          .returning(sectionColumns);
        if (!created) throw new Error('Section was not created');
        await recordAudit(tx, request, {
          action: 'section.created',
          entityType: 'section',
          entityId: created.id,
          before: null,
          after: { courseId: course.id, title: created.title, position: created.position, isVisible: created.isVisible },
        });
        return created;
      });
      return reply.code(201).send(section);
    },
  );

  app.put<{ Params: CourseParams; Body: { sectionIds: string[] } }>(
    '/courses/:id/sections/order',
    { ...adminWrite, schema: { params: courseIdParamsSchema, body: sectionOrderSchema, response: { 200: sectionListSchema } } },
    async (request) => {
      const requested = request.body.sectionIds;
      if (new Set(requested).size !== requested.length) {
        throw new ApiProblem(422, 'INVALID_SECTION_ORDER', 'Each section can appear only once.');
      }
      return db.transaction(async (tx) => {
        const course = await lockCourse(tx, request.params.id);
        const current = await tx.select({ id: sections.id }).from(sections).where(eq(sections.courseId, course.id)).orderBy(asc(sections.position), asc(sections.id));
        const currentIds = current.map((s) => s.id);
        const known = new Set(currentIds);
        if (requested.length !== currentIds.length || requested.some((id) => !known.has(id))) {
          throw new ApiProblem(409, 'SECTION_ORDER_STALE', 'The list must contain every section of this course exactly once. Reload and try again.');
        }
        if (requested.some((id, index) => currentIds[index] !== id)) {
          for (const [index, id] of requested.entries()) {
            await tx.update(sections).set({ position: index }).where(and(eq(sections.id, id), eq(sections.courseId, course.id)));
          }
          await recordAudit(tx, request, {
            action: 'sections.reordered',
            entityType: 'course',
            entityId: course.id,
            before: { order: currentIds },
            after: { order: requested },
          });
        } else {
          // Positions are normalized to 0..n-1 even when the order is unchanged.
          for (const [index, id] of requested.entries()) {
            await tx.update(sections).set({ position: index }).where(and(eq(sections.id, id), eq(sections.courseId, course.id), sql`${sections.position} <> ${index}`));
          }
        }
        const items = await tx.select(sectionColumns).from(sections).where(eq(sections.courseId, course.id)).orderBy(asc(sections.position), asc(sections.id));
        return { items };
      });
    },
  );

  app.put<{ Params: SectionParams; Body: { title?: string; summary?: string | null; isVisible?: boolean } }>(
    '/courses/:id/sections/:sectionId',
    { ...adminWrite, schema: { params: sectionParamsSchema, body: sectionUpdateSchema, response: { 200: courseSectionSchema } } },
    async (request) => {
      const body = request.body;
      const next = {
        ...(body.title !== undefined ? { title: body.title.trim() } : {}),
        ...(body.summary !== undefined ? { summary: optionalText(body.summary) ?? null } : {}),
        ...(body.isVisible !== undefined ? { isVisible: body.isVisible } : {}),
      };
      return db.transaction(async (tx) => {
        const course = await lockCourse(tx, request.params.id);
        // Scoped to the course in the path: a section of another course is "not found".
        const [section] = await tx
          .select(sectionColumns)
          .from(sections)
          .where(and(eq(sections.id, request.params.sectionId), eq(sections.courseId, course.id)))
          .for('update');
        if (!section) throw sectionNotFound();
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(next) as Array<[keyof typeof next, string | boolean | null]>) {
          if (section[key] !== value) {
            before[key] = section[key];
            after[key] = value;
          }
        }
        if (Object.keys(after).length === 0) return section;
        const [updated] = await tx.update(sections).set(after).where(eq(sections.id, section.id)).returning(sectionColumns);
        if (!updated) throw sectionNotFound();
        await recordAudit(tx, request, { action: 'section.updated', entityType: 'section', entityId: section.id, before: { courseId: course.id, ...before }, after: { courseId: course.id, ...after } });
        return updated;
      });
    },
  );
};
