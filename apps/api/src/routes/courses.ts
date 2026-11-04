import { and, asc, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { recordAudit } from '../audit.js';
import {
  canInCourse,
  getCourseAccess,
  isAdministrator,
  UNPUBLISHED_VIEWER_ROLES,
  type CourseAccess,
  type CourseRecord,
} from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import { withUniqueConflict } from '../db/errors.js';
import {
  courseTemplateSections,
  courseTemplateVersions,
  courseTemplates,
  courses,
  enrollments,
  programs,
  sections,
  terms,
  users,
  type CourseRole,
} from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';
import { decodeCursor, paginationQuerySchema, toPage, type PaginationQuery } from '../http/pagination.js';
import {
  courseCreateSchema,
  courseIdParamsSchema,
  courseListQuerySchema,
  courseSchema,
  courseSectionSchema,
  enrollmentCreateSchema,
  enrollmentSchema,
  pageSchema,
} from './course-schemas.js';

type CourseParams = { id: string };
type CourseCreateBody = {
  programId: string;
  termId: string;
  templateId: string;
  templateVersion?: number;
  code: string;
  title?: string;
  description?: string;
  status: 'draft' | 'published';
};
type EnrollmentCreateBody = { userId?: string; email?: string; role: CourseRole };

const courseNotFound = () => new ApiProblem(404, 'NOT_FOUND', 'Course not found.');

function toCourse(course: CourseRecord, viewerRole: CourseRole | null) {
  return { ...course, viewerRole };
}

const enrollmentColumns = {
  id: enrollments.id,
  courseId: enrollments.courseId,
  role: enrollments.role,
  status: enrollments.status,
  createdAt: enrollments.createdAt,
  user: { id: users.id, email: users.email, givenName: users.givenName, familyName: users.familyName },
};

export const courseRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  // Guards run before body/params validation so unauthenticated callers are rejected first.
  const authenticated = { preValidation: [app.requireAuth] };
  const adminWrite = { preValidation: [app.requireAuth, app.requireCsrf, app.requireAdministrator] };

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  /** Default deny: 404 unless the caller may see the course (does not reveal existence). */
  async function requireCourseAccess(courseId: string, request: Parameters<typeof getAuth>[0]): Promise<CourseAccess> {
    const access = await getCourseAccess(db, getAuth(request).user, courseId);
    if (!access) throw courseNotFound();
    return access;
  }

  // ---- Courses ----

  app.get<{ Querystring: PaginationQuery & { termId?: string; programId?: string; templateId?: string } }>(
    '/courses',
    { ...authenticated, schema: { querystring: courseListQuerySchema, response: { 200: pageSchema(courseSchema) } } },
    async (request) => {
      const { user } = getAuth(request);
      const { limit, termId, programId, templateId } = request.query;
      const after = decodeCursor(request.query.cursor, 'string');
      const visibility = isAdministrator(user)
        ? undefined
        : and(
            isNotNull(enrollments.id),
            or(eq(courses.status, 'published'), inArray(enrollments.role, UNPUBLISHED_VIEWER_ROLES)),
          );

      const rows = await db
        .select({ course: courses, viewerRole: enrollments.role })
        .from(courses)
        .leftJoin(
          enrollments,
          and(eq(enrollments.courseId, courses.id), eq(enrollments.userId, user.id), eq(enrollments.status, 'active')),
        )
        .where(
          and(
            visibility,
            // Optional hierarchy filters; they only narrow what the caller may already see.
            termId ? eq(courses.termId, termId) : undefined,
            programId ? eq(courses.programId, programId) : undefined,
            templateId ? eq(courses.templateId, templateId) : undefined,
            after ? sql`(${courses.code}, ${courses.id}) > (${after.key}, ${after.id}::uuid)` : undefined,
          ),
        )
        .orderBy(asc(courses.code), asc(courses.id))
        .limit(limit + 1);

      const page = toPage(rows, limit, (row) => [row.course.code, row.course.id]);
      return { items: page.items.map((row) => toCourse(row.course, row.viewerRole)), nextCursor: page.nextCursor };
    },
  );

  app.get<{ Params: CourseParams }>(
    '/courses/:id',
    { ...authenticated, schema: { params: courseIdParamsSchema, response: { 200: courseSchema } } },
    async (request) => {
      const access = await requireCourseAccess(request.params.id, request);
      return toCourse(access.course, access.viewerRole);
    },
  );

  app.post<{ Body: CourseCreateBody }>(
    '/courses',
    { ...adminWrite, schema: { body: courseCreateSchema, response: { 201: courseSchema } } },
    async (request, reply) => {
      const body = request.body;

      const course = await db.transaction(async (tx) => {
        const [program] = await tx.select().from(programs).where(eq(programs.id, body.programId));
        if (!program) throw new ApiProblem(422, 'PROGRAM_NOT_FOUND', 'The program does not exist.');
        if (!program.isActive) throw new ApiProblem(422, 'PROGRAM_INACTIVE', 'The program is not active.');

        const [term] = await tx.select({ id: terms.id }).from(terms).where(eq(terms.id, body.termId));
        if (!term) throw new ApiProblem(422, 'TERM_NOT_FOUND', 'The term does not exist.');

        const [template] = await tx.select().from(courseTemplates).where(eq(courseTemplates.id, body.templateId));
        if (!template) throw new ApiProblem(422, 'TEMPLATE_NOT_FOUND', 'The course template does not exist.');
        if (template.programId !== null && template.programId !== program.id) {
          throw new ApiProblem(422, 'TEMPLATE_PROGRAM_MISMATCH', 'The course template belongs to a different program.');
        }

        const [version] = await tx
          .select()
          .from(courseTemplateVersions)
          .where(
            and(
              eq(courseTemplateVersions.templateId, template.id),
              body.templateVersion === undefined ? undefined : eq(courseTemplateVersions.version, body.templateVersion),
            ),
          )
          .orderBy(desc(courseTemplateVersions.version))
          .limit(1);
        if (!version) {
          throw new ApiProblem(422, 'TEMPLATE_VERSION_NOT_FOUND', 'The course template version does not exist.');
        }

        const [created] = await withUniqueConflict(
          () =>
            tx
              .insert(courses)
              .values({
                termId: term.id,
                programId: program.id,
                templateId: template.id,
                templateVersionId: version.id,
                code: body.code,
                title: body.title ?? version.title,
                description: body.description ?? version.description,
                status: body.status,
              })
              .returning(),
          'courses_term_id_code_unique',
          'COURSE_CODE_TAKEN',
          'A course with this code already exists in the term.',
        );
        if (!created) throw new Error('Course was not created');

        // Copy the template version's structure into the course (same transaction).
        const templateSections = await tx
          .select()
          .from(courseTemplateSections)
          .where(eq(courseTemplateSections.templateVersionId, version.id))
          .orderBy(asc(courseTemplateSections.position));
        if (templateSections.length) {
          await tx.insert(sections).values(
            templateSections.map((section) => ({
              courseId: created.id,
              title: section.title,
              summary: section.summary,
              position: section.position,
              isVisible: section.isVisible,
            })),
          );
        }

        await recordAudit(tx, request, {
          action: 'course.created',
          entityType: 'course',
          entityId: created.id,
          before: null,
          after: {
            code: created.code,
            title: created.title,
            status: created.status,
            programId: created.programId,
            termId: created.termId,
            templateId: created.templateId,
            templateVersionId: created.templateVersionId,
            templateVersion: version.version,
            sectionCount: templateSections.length,
          },
        });
        return created;
      });

      return reply.code(201).send(toCourse(course, null));
    },
  );

  // ---- Sections ----

  app.get<{ Params: CourseParams; Querystring: PaginationQuery }>(
    '/courses/:id/sections',
    {
      ...authenticated,
      schema: {
        params: courseIdParamsSchema,
        querystring: paginationQuerySchema,
        response: { 200: pageSchema(courseSectionSchema) },
      },
    },
    async (request) => {
      const access = await requireCourseAccess(request.params.id, request);
      const { limit } = request.query;
      const after = decodeCursor(request.query.cursor, 'number');
      const rows = await db
        .select({
          id: sections.id,
          title: sections.title,
          summary: sections.summary,
          position: sections.position,
          isVisible: sections.isVisible,
        })
        .from(sections)
        .where(
          and(
            eq(sections.courseId, access.course.id),
            canInCourse(access, 'sections.viewHidden') ? undefined : eq(sections.isVisible, true),
            after ? sql`(${sections.position}, ${sections.id}) > (${after.key}::int, ${after.id}::uuid)` : undefined,
          ),
        )
        .orderBy(asc(sections.position), asc(sections.id))
        .limit(limit + 1);
      return toPage(rows, limit, (row) => [row.position, row.id]);
    },
  );

  // ---- Enrollments ----

  app.get<{ Params: CourseParams; Querystring: PaginationQuery }>(
    '/courses/:id/enrollments',
    {
      ...authenticated,
      schema: {
        params: courseIdParamsSchema,
        querystring: paginationQuerySchema,
        response: { 200: pageSchema(enrollmentSchema) },
      },
    },
    async (request) => {
      const access = await requireCourseAccess(request.params.id, request);
      const { user } = getAuth(request);
      const { limit } = request.query;
      const after = decodeCursor(request.query.cursor, 'string');
      const emailKey = sql<string>`lower(${users.email})`;
      const rows = await db
        .select({ ...enrollmentColumns, emailKey })
        .from(enrollments)
        .innerJoin(users, eq(users.id, enrollments.userId))
        .where(
          and(
            eq(enrollments.courseId, access.course.id),
            // Without roster access (students), only the caller's own enrollment is visible.
            canInCourse(access, 'enrollments.viewAll') ? undefined : eq(enrollments.userId, user.id),
            after ? sql`(${emailKey}, ${enrollments.id}) > (${after.key}, ${after.id}::uuid)` : undefined,
          ),
        )
        .orderBy(asc(emailKey), asc(enrollments.id))
        .limit(limit + 1);
      const page = toPage(rows, limit, (row) => [row.emailKey, row.id]);
      return { items: page.items.map(({ emailKey: _key, ...enrollment }) => enrollment), nextCursor: page.nextCursor };
    },
  );

  app.post<{ Params: CourseParams; Body: EnrollmentCreateBody }>(
    '/courses/:id/enrollments',
    {
      ...adminWrite,
      schema: { params: courseIdParamsSchema, body: enrollmentCreateSchema, response: { 201: enrollmentSchema } },
    },
    async (request, reply) => {
      const { userId, email, role } = request.body;

      const enrollment = await db.transaction(async (tx) => {
        const [course] = await tx.select({ id: courses.id }).from(courses).where(eq(courses.id, request.params.id));
        if (!course) throw courseNotFound();

        const [target] = await tx
          .select()
          .from(users)
          .where(userId ? eq(users.id, userId) : sql`lower(${users.email}) = lower(${email ?? ''})`)
          .limit(1);
        if (!target) throw new ApiProblem(422, 'USER_NOT_FOUND', 'The user does not exist.');
        if (!target.isActive) throw new ApiProblem(422, 'USER_INACTIVE', 'The user account is not active.');

        const [created] = await withUniqueConflict(
          () => tx.insert(enrollments).values({ courseId: course.id, userId: target.id, role }).returning(),
          'enrollments_course_id_user_id_unique',
          'ENROLLMENT_EXISTS',
          'The user is already enrolled in this course.',
        );
        if (!created) throw new Error('Enrollment was not created');

        await recordAudit(tx, request, {
          action: 'enrollment.created',
          entityType: 'enrollment',
          entityId: created.id,
          before: null,
          after: { courseId: created.courseId, userId: created.userId, role: created.role, status: created.status },
        });

        return {
          id: created.id,
          courseId: created.courseId,
          role: created.role,
          status: created.status,
          createdAt: created.createdAt,
          user: { id: target.id, email: target.email, givenName: target.givenName, familyName: target.familyName },
        };
      });

      return reply.code(201).send(enrollment);
    },
  );
};
