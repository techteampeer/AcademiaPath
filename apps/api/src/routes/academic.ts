import { asc, desc, eq, inArray, max, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { recordAudit } from '../audit.js';
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
  courseTemplateSchema,
  courseTemplateVersionSchema,
  pageSchema,
  programCreateSchema,
  programSchema,
  termCreateSchema,
  termSchema,
} from './course-schemas.js';

type ProgramCreateBody = { code: string; name: string; description?: string };
type TermCreateBody = { code: string; name: string; startsOn: string; endsOn: string };
type CourseTemplateCreateBody = {
  code: string;
  programId?: string | null;
  title: string;
  description?: string;
  sections: Array<{ title: string; summary?: string; isVisible: boolean }>;
};

/** Institutional academic structure. Every route is administrator-only. */
export const academicRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  // Guards run before body/params validation so unauthorized callers are rejected first.
  const adminRead = { preValidation: [app.requireAuth, app.requireAdministrator] };
  const adminWrite = { preValidation: [app.requireAuth, app.requireCsrf, app.requireAdministrator] };

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

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
      const term = await db.transaction(async (tx) => {
        const [row] = await withUniqueConflict(
          () => tx.insert(terms).values({ code, name, startsOn, endsOn }).returning(),
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
          after: { code: row.code, name: row.name, startsOn: row.startsOn, endsOn: row.endsOn },
        });
        return row;
      });
      return reply.code(201).send(term);
    },
  );

  // ---- Course templates (versioned) ----

  app.get<{ Querystring: PaginationQuery }>(
    '/course-templates',
    {
      ...adminRead,
      schema: { querystring: paginationQuerySchema, response: { 200: pageSchema(courseTemplateSchema) } },
    },
    async (request) => {
      const { limit } = request.query;
      const after = decodeCursor(request.query.cursor, 'string');
      const rows = await db
        .select()
        .from(courseTemplates)
        .where(
          after ? sql`(${courseTemplates.code}, ${courseTemplates.id}) > (${after.key}, ${after.id}::uuid)` : undefined,
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
    { ...adminWrite, schema: { body: courseTemplateCreateSchema, response: { 201: courseTemplateVersionSchema } } },
    async (request, reply) => {
      const { code, title, description, sections } = request.body;
      const programId = request.body.programId ?? null;

      const created = await db.transaction(async (tx) => {
        // Lock an existing template so concurrent requests cannot take the same version number.
        const [existing] = await tx.select().from(courseTemplates).where(eq(courseTemplates.code, code)).for('update');

        let template: typeof courseTemplates.$inferSelect;
        let version: number;
        let before: Record<string, unknown> | null = null;

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
};
