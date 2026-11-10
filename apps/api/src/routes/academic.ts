import { and, asc, count, desc, eq, inArray, max, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { assertCanManageProgram, canReadProgram, notProgramManager, readableProgramFilter } from '../academics/program-access.js';
import { recordAudit } from '../audit.js';
import { getAuth } from '../auth/hooks.js';
import { withUniqueConflict } from '../db/errors.js';
import {
  courseTemplateSections,
  courseTemplateVersions,
  courseTemplates,
  programs,
  terms,
} from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';
import { decodeCursor, paginationQuerySchema, toPage, type PaginationQuery } from '../http/pagination.js';
import {
  courseTemplateCreateSchema,
  courseTemplateDetailSchema,
  courseTemplateListQuerySchema,
  courseTemplateVersionListSchema,
  courseTemplateSchema,
  courseTemplateVersionSchema,
  pageSchema,
  programCreateSchema,
  programParamsSchema,
  programSchema,
  programUpdateSchema,
  templateParamsSchema,
  termCreateSchema,
  termParamsSchema,
  termSchema,
  termUpdateSchema,
} from './course-schemas.js';

type ProgramCreateBody = { code: string; name: string; description?: string };
type ProgramUpdateBody = { name: string; description?: string | null; isActive: boolean };
type TermCreateBody = { code: string; name: string; academicYear?: number; startsOn: string; endsOn: string };
type TermUpdateBody = { name: string; startsOn: string; endsOn: string };
type CourseTemplateCreateBody = {
  code: string;
  programId?: string | null;
  title: string;
  description?: string;
  baseVersion?: number;
  sections: Array<{ title: string; summary?: string; isVisible: boolean }>;
};

const notFound = (what: string) => new ApiProblem(404, 'NOT_FOUND', `${what} not found.`);

/**
 * Academic year of a new term: the year of a Peru-style code (2026-1 → 2026) or of the start date.
 * An explicit year must agree with a year-prefixed code.
 */
function termAcademicYear(code: string, startsOn: string, requested?: number): number {
  const fromCode = /^(\d{4})-/.exec(code)?.[1];
  const codeYear = fromCode ? Number(fromCode) : null;
  if (requested !== undefined && codeYear !== null && requested !== codeYear) {
    throw new ApiProblem(422, 'TERM_YEAR_MISMATCH', `The term code ${code} belongs to ${codeYear}, not ${requested}.`);
  }
  const year = requested ?? codeYear ?? Number(startsOn.slice(0, 4));
  if (year < 2000 || year > 2100) {
    throw new ApiProblem(422, 'TERM_YEAR_MISMATCH', 'The academic year must be between 2000 and 2100.');
  }
  return year;
}

/**
 * Institutional academic structure. Programs and terms are administrator-only. Subjects (course
 * templates) are also open to program managers, for the programs they hold a grant for: the program
 * is always taken from the stored subject when one exists, and write checks run inside the writing
 * transaction (see academics/program-access.ts).
 */
export const academicRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  // Guards run before body/params validation so unauthorized callers are rejected first.
  const adminRead = { preValidation: [app.requireAuth, app.requireAdministrator] };
  const adminWrite = { preValidation: [app.requireAuth, app.requireCsrf, app.requireAdministrator] };
  // Subject routes: any signed-in user reaches the handler, which authorizes per program (default deny).
  const signedIn = { preValidation: [app.requireAuth] };
  const signedInWrite = { preValidation: [app.requireAuth, app.requireCsrf] };

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  /** A subject the caller may read: 403 without any program grant, 404 if missing, 403 for another program. */
  async function readableTemplate(templateId: string, user: Parameters<typeof canReadProgram>[1]) {
    const readable = await readableProgramFilter(db, user);
    if (readable !== null && readable.length === 0) throw notProgramManager();
    const [template] = await db.select().from(courseTemplates).where(eq(courseTemplates.id, templateId));
    if (!template) throw notFound('Subject');
    if (!(await canReadProgram(db, user, template.programId))) throw notProgramManager();
    return template;
  }

  // ---- Programs ----

  app.get<{ Querystring: PaginationQuery }>(
    '/programs',
    { ...adminRead, schema: { querystring: paginationQuerySchema, response: { 200: pageSchema(programSchema) } } },
    async (request) => {
      const { limit } = request.query;
      const after = decodeCursor(request.query.cursor, 'string');
      const rows = await db
        .select()
        .from(programs)
        .where(after ? sql`(${programs.code}, ${programs.id}) > (${after.key}, ${after.id}::uuid)` : undefined)
        .orderBy(asc(programs.code), asc(programs.id))
        .limit(limit + 1);
      return toPage(rows, limit, (row) => [row.code, row.id]);
    },
  );

  app.post<{ Body: ProgramCreateBody }>(
    '/programs',
    { ...adminWrite, schema: { body: programCreateSchema, response: { 201: programSchema } } },
    async (request, reply) => {
      const { code, name, description } = request.body;
      const program = await db.transaction(async (tx) => {
        const [row] = await withUniqueConflict(
          () => tx.insert(programs).values({ code, name, description }).returning(),
          'programs_code_unique',
          'PROGRAM_CODE_TAKEN',
          'A program with this code already exists.',
        );
        if (!row) throw new Error('Program was not created');
        await recordAudit(tx, request, {
          action: 'program.created',
          entityType: 'program',
          entityId: row.id,
          before: null,
          after: { code: row.code, name: row.name, description: row.description, isActive: row.isActive },
        });
        return row;
      });
      return reply.code(201).send(program);
    },
  );

  app.put<{ Params: { programId: string }; Body: ProgramUpdateBody }>(
    '/programs/:programId',
    { ...adminWrite, schema: { params: programParamsSchema, body: programUpdateSchema, response: { 200: programSchema } } },
    async (request) => {
      const name = request.body.name.trim();
      const description = request.body.description?.trim() || null;
      const { isActive } = request.body;
      return db.transaction(async (tx) => {
        const [current] = await tx.select().from(programs).where(eq(programs.id, request.params.programId)).for('update');
        if (!current) throw notFound('Program');
        const [row] = await tx.update(programs).set({ name, description, isActive }).where(eq(programs.id, current.id)).returning();
        if (!row) throw new Error('Program was not updated');
        await recordAudit(tx, request, {
          action: 'program.updated',
          entityType: 'program',
          entityId: row.id,
          before: { name: current.name, description: current.description, isActive: current.isActive },
          after: { name: row.name, description: row.description, isActive: row.isActive },
        });
        return row;
      });
    },
  );

  // ---- Terms ----

  app.get<{ Querystring: PaginationQuery }>(
    '/terms',
    { ...adminRead, schema: { querystring: paginationQuerySchema, response: { 200: pageSchema(termSchema) } } },
    async (request) => {
      const { limit } = request.query;
      const after = decodeCursor(request.query.cursor, 'string');
      const rows = await db
        .select()
        .from(terms)
        .where(after ? sql`(${terms.code}, ${terms.id}) > (${after.key}, ${after.id}::uuid)` : undefined)
        .orderBy(asc(terms.code), asc(terms.id))
        .limit(limit + 1);
      return toPage(rows, limit, (row) => [row.code, row.id]);
    },
  );

  app.post<{ Body: TermCreateBody }>(
    '/terms',
    { ...adminWrite, schema: { body: termCreateSchema, response: { 201: termSchema } } },
    async (request, reply) => {
      const { code, name, startsOn, endsOn } = request.body;
      if (endsOn < startsOn) {
        throw new ApiProblem(422, 'INVALID_TERM_DATES', 'The term cannot end before it starts.');
      }
      const academicYear = termAcademicYear(code, startsOn, request.body.academicYear);
      const term = await db.transaction(async (tx) => {
        const [row] = await withUniqueConflict(
          () => tx.insert(terms).values({ code, name, academicYear, startsOn, endsOn }).returning(),
          'terms_code_unique',
          'TERM_CODE_TAKEN',
          'A term with this code already exists.',
        );
        if (!row) throw new Error('Term was not created');
        await recordAudit(tx, request, {
          action: 'term.created',
          entityType: 'term',
          entityId: row.id,
          before: null,
          after: { code: row.code, name: row.name, academicYear: row.academicYear, startsOn: row.startsOn, endsOn: row.endsOn },
        });
        return row;
      });
      return reply.code(201).send(term);
    },
  );

  app.put<{ Params: { termId: string }; Body: TermUpdateBody }>(
    '/terms/:termId',
    { ...adminWrite, schema: { params: termParamsSchema, body: termUpdateSchema, response: { 200: termSchema } } },
    async (request) => {
      const { startsOn, endsOn } = request.body;
      const name = request.body.name.trim();
      if (endsOn < startsOn) {
        throw new ApiProblem(422, 'INVALID_TERM_DATES', 'The term cannot end before it starts.');
      }
      return db.transaction(async (tx) => {
        const [current] = await tx.select().from(terms).where(eq(terms.id, request.params.termId)).for('update');
        if (!current) throw notFound('Term');
        // Code and academic year are the term's identity and never change here.
        const [row] = await tx.update(terms).set({ name, startsOn, endsOn }).where(eq(terms.id, current.id)).returning();
        if (!row) throw new Error('Term was not updated');
        await recordAudit(tx, request, {
          action: 'term.updated',
          entityType: 'term',
          entityId: row.id,
          before: { name: current.name, startsOn: current.startsOn, endsOn: current.endsOn },
          after: { name: row.name, startsOn: row.startsOn, endsOn: row.endsOn },
        });
        return row;
      });
    },
  );

  // ---- Course templates (versioned) ----

  app.get<{ Querystring: PaginationQuery & { programId?: string } }>(
    '/course-templates',
    {
      ...signedIn,
      schema: { querystring: courseTemplateListQuerySchema, response: { 200: pageSchema(courseTemplateSchema) } },
    },
    async (request) => {
      const { limit, programId } = request.query;
      const after = decodeCursor(request.query.cursor, 'string');
      // Administrators: every subject. Program managers: subjects of their programs only. Others: 403.
      const readable = await readableProgramFilter(db, getAuth(request).user);
      if (readable !== null && readable.length === 0) throw notProgramManager();
      const rows = await db
        .select()
        .from(courseTemplates)
        .where(
          and(
            readable !== null ? inArray(courseTemplates.programId, readable) : undefined,
            programId ? eq(courseTemplates.programId, programId) : undefined,
            after ? sql`(${courseTemplates.code}, ${courseTemplates.id}) > (${after.key}, ${after.id}::uuid)` : undefined,
          ),
        )
        .orderBy(asc(courseTemplates.code), asc(courseTemplates.id))
        .limit(limit + 1);
      const page = toPage(rows, limit, (row) => [row.code, row.id]);

      const ids = page.items.map((row) => row.id);
      const latest = ids.length
        ? await db
            .selectDistinctOn([courseTemplateVersions.templateId], {
              templateId: courseTemplateVersions.templateId,
              id: courseTemplateVersions.id,
              version: courseTemplateVersions.version,
              createdAt: courseTemplateVersions.createdAt,
            })
            .from(courseTemplateVersions)
            .where(inArray(courseTemplateVersions.templateId, ids))
            .orderBy(courseTemplateVersions.templateId, desc(courseTemplateVersions.version))
        : [];
      const latestByTemplate = new Map(latest.map(({ templateId, ...version }) => [templateId, version]));

      return {
        items: page.items.map((row) => ({ ...row, latestVersion: latestByTemplate.get(row.id) ?? null })),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.post<{ Body: CourseTemplateCreateBody }>(
    '/course-templates',
    { ...signedInWrite, schema: { body: courseTemplateCreateSchema, response: { 201: courseTemplateVersionSchema } } },
    async (request, reply) => {
      const { user } = getAuth(request);
      const { code, title, description, sections } = request.body;
      const programId = request.body.programId ?? null;

      const created = await db.transaction(async (tx) => {
        // Lock an existing template so concurrent requests cannot take the same version number.
        const [existing] = await tx.select().from(courseTemplates).where(eq(courseTemplates.code, code)).for('update');
        // Authorize first (before any check that could reveal another program's subjects): against the
        // stored subject's program when it exists, else against the target program of the new subject.
        await assertCanManageProgram(tx, user, existing ? existing.programId : programId);

        let template: typeof courseTemplates.$inferSelect;
        let version: number;
        let before: Record<string, unknown> | null = null;

        // Optional guard: 0 = create a new subject only; n = only if version n is still the latest.
        const { baseVersion } = request.body;
        if (baseVersion === 0 && existing) {
          throw new ApiProblem(409, 'TEMPLATE_CODE_TAKEN', 'A subject with this code already exists.');
        }
        if (baseVersion !== undefined && baseVersion > 0 && !existing) throw notFound('Subject');

        if (existing) {
          if (existing.programId !== programId) {
            throw new ApiProblem(
              422,
              'TEMPLATE_PROGRAM_MISMATCH',
              'A template with this code exists for a different program.',
            );
          }
          const [{ latest } = { latest: null }] = await tx
            .select({ latest: max(courseTemplateVersions.version) })
            .from(courseTemplateVersions)
            .where(eq(courseTemplateVersions.templateId, existing.id));
          if (baseVersion !== undefined && baseVersion !== (latest ?? 0)) {
            throw new ApiProblem(
              409,
              'TEMPLATE_VERSION_CONFLICT',
              `The subject is now at version ${latest ?? 0}; reload it before saving a new version.`,
            );
          }
          version = (latest ?? 0) + 1;
          before = { title: existing.title, description: existing.description, latestVersion: latest };
          const [updated] = await tx
            .update(courseTemplates)
            .set({ title, description: description ?? null })
            .where(eq(courseTemplates.id, existing.id))
            .returning();
          if (!updated) throw new Error('Template was not updated');
          template = updated;
        } else {
          if (programId) {
            const [program] = await tx.select({ id: programs.id }).from(programs).where(eq(programs.id, programId));
            if (!program) throw new ApiProblem(422, 'PROGRAM_NOT_FOUND', 'The program does not exist.');
          }
          const [inserted] = await withUniqueConflict(
            () => tx.insert(courseTemplates).values({ code, programId, title, description }).returning(),
            'course_templates_code_unique',
            'TEMPLATE_VERSION_CONFLICT',
            'The template was changed concurrently. Retry the request.',
          );
          if (!inserted) throw new Error('Template was not created');
          template = inserted;
          version = 1;
        }

        const [versionRow] = await withUniqueConflict(
          () =>
            tx
              .insert(courseTemplateVersions)
              .values({ templateId: template.id, version, title, description })
              .returning(),
          'course_template_versions_template_id_version_unique',
          'TEMPLATE_VERSION_CONFLICT',
          'The template was changed concurrently. Retry the request.',
        );
        if (!versionRow) throw new Error('Template version was not created');

        const sectionRows = sections.length
          ? await tx
              .insert(courseTemplateSections)
              .values(
                sections.map((section, position) => ({
                  templateVersionId: versionRow.id,
                  title: section.title,
                  summary: section.summary,
                  position,
                  isVisible: section.isVisible,
                })),
              )
              .returning()
          : [];

        await recordAudit(tx, request, {
          action: existing ? 'course_template.version_created' : 'course_template.created',
          entityType: 'course_template_version',
          entityId: versionRow.id,
          before,
          after: {
            templateId: template.id,
            code: template.code,
            programId: template.programId,
            version,
            title,
            description: versionRow.description,
            sectionCount: sectionRows.length,
          },
        });

        return {
          id: versionRow.id,
          templateId: template.id,
          programId: template.programId,
          code: template.code,
          version: versionRow.version,
          title: versionRow.title,
          description: versionRow.description,
          sections: sectionRows.sort((a, b) => a.position - b.position),
          createdAt: versionRow.createdAt,
        };
      });

      return reply.code(201).send(created);
    },
  );

  app.get<{ Params: { templateId: string } }>(
    '/course-templates/:templateId',
    { ...signedIn, schema: { params: templateParamsSchema, response: { 200: courseTemplateDetailSchema } } },
    async (request) => {
      const template = await readableTemplate(request.params.templateId, getAuth(request).user);
      const [{ versionCount } = { versionCount: 0 }] = await db
        .select({ versionCount: count() })
        .from(courseTemplateVersions)
        .where(eq(courseTemplateVersions.templateId, template.id));
      const [latest] = await db
        .select()
        .from(courseTemplateVersions)
        .where(eq(courseTemplateVersions.templateId, template.id))
        .orderBy(desc(courseTemplateVersions.version))
        .limit(1);
      const sections = latest
        ? await db
            .select()
            .from(courseTemplateSections)
            .where(eq(courseTemplateSections.templateVersionId, latest.id))
            .orderBy(asc(courseTemplateSections.position))
        : [];
      return {
        ...template,
        versionCount,
        latestVersion: latest
          ? {
              id: latest.id,
              templateId: template.id,
              programId: template.programId,
              code: template.code,
              version: latest.version,
              title: latest.title,
              description: latest.description,
              sections,
              createdAt: latest.createdAt,
            }
          : null,
      };
    },
  );

  app.get<{ Params: { templateId: string } }>(
    '/course-templates/:templateId/versions',
    { ...signedIn, schema: { params: templateParamsSchema, response: { 200: courseTemplateVersionListSchema } } },
    async (request) => {
      const template = await readableTemplate(request.params.templateId, getAuth(request).user);
      const items = await db
        .select({
          id: courseTemplateVersions.id,
          version: courseTemplateVersions.version,
          title: courseTemplateVersions.title,
          description: courseTemplateVersions.description,
          // Correlated subquery: the outer column is written fully qualified (Drizzle renders single-table columns unqualified).
          sectionCount: sql<number>`(SELECT count(*)::int FROM course_template_sections cts WHERE cts.template_version_id = "course_template_versions"."id")`,
          createdAt: courseTemplateVersions.createdAt,
        })
        .from(courseTemplateVersions)
        .where(eq(courseTemplateVersions.templateId, template.id))
        .orderBy(desc(courseTemplateVersions.version));
      return { items };
    },
  );
};
