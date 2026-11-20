import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { recordAudit } from '../audit.js';
import { getAuth } from '../auth/hooks.js';
import { withUniqueConflict } from '../db/errors.js';
import { courses, programs, terms } from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';
import { analyzePackage, IMPORT_MAX_BYTES, type PackageAnalysis, type VersionPreference } from '../portability/course-import.js';
import { reconstructCourse } from '../portability/course-reconstruct.js';
import { importCreateSchema, importPreviewSchema, importResultSchema } from './course-import-schemas.js';

type CreateBody = {
  package: Record<string, unknown>;
  programId: string;
  termId: string;
  code: string;
  title?: string;
  versionPreference: VersionPreference;
  acknowledgeSkipped: boolean;
  assignmentDueAt?: string;
};

/** The package plus the few confirmation fields. */
const BODY_LIMIT = IMPORT_MAX_BYTES + 64 * 1024;

/** Turns a refused analysis into the matching problem (the preview lists every issue; the import names the first). */
function refusal(analysis: PackageAnalysis): ApiProblem {
  const first = analysis.preview.errors[0];
  const where = first ? ` (${first.path}: ${first.message})` : '';
  if (analysis.fatal === 'version') return new ApiProblem(422, 'IMPORT_VERSION_UNSUPPORTED', `Only course package version ${analysis.preview.supportedFormatVersion} can be imported.`);
  if (analysis.fatal === 'hash') return new ApiProblem(422, 'IMPORT_HASH_MISMATCH', 'The package content does not match its hash: the file was changed after it was exported.');
  return new ApiProblem(422, 'IMPORT_PACKAGE_INVALID', `The course package is not valid${where}. Preview it to see every problem.`);
}

/**
 * AP-038B: import an AP-038A course package as a NEW draft course. Administrators only, like creating a course.
 * Two stateless steps: preview (validation only, nothing is written) and import (validates again and creates the course,
 * its units, prerequisites, folders and draft activities in one transaction). Nothing in the package is used as a
 * database identifier, no existing course is changed, and no people, enrollments or student work are ever created.
 */
export const courseImportRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const adminWrite = { preValidation: [app.requireAuth, app.requireCsrf, app.requireAdministrator], bodyLimit: BODY_LIMIT };

  app.post('/course-imports/preview', { ...adminWrite, schema: { response: { 200: importPreviewSchema } } }, async (request) => analyzePackage(request.body).preview);

  app.post<{ Body: CreateBody }>(
    '/course-imports',
    { ...adminWrite, schema: { body: importCreateSchema, response: { 201: importResultSchema } } },
    async (request, reply) => {
      const body = request.body;
      const userId = getAuth(request).user.id;
      const analysis = analyzePackage(body.package, body.versionPreference);
      if (analysis.fatal || !analysis.plan) throw refusal(analysis);
      const { preview, plan } = analysis;
      if (preview.requiresAcknowledgement && !body.acknowledgeSkipped) {
        throw new ApiProblem(
          422,
          'IMPORT_ACKNOWLEDGEMENT_REQUIRED',
          `${preview.skipped.length} activities cannot be imported (documents without their files, or types that are not portable yet). Confirm that the course may be imported without them.`,
        );
      }
      if (preview.requiresDueDate && !body.assignmentDueAt) {
        throw new ApiProblem(422, 'IMPORT_DUE_DATE_REQUIRED', 'Choose a due date for the imported assignments: the dates in the package belong to the source term.');
      }

      const result = await db.transaction(async (tx) => {
        const [program] = await tx.select().from(programs).where(eq(programs.id, body.programId));
        if (!program) throw new ApiProblem(422, 'PROGRAM_NOT_FOUND', 'The program does not exist.');
        if (!program.isActive) throw new ApiProblem(422, 'PROGRAM_INACTIVE', 'The program is not active.');
        const [term] = await tx.select({ id: terms.id }).from(terms).where(eq(terms.id, body.termId));
        if (!term) throw new ApiProblem(422, 'TERM_NOT_FOUND', 'The term does not exist.');

        // Always a new course: the code must be free in the term (a repeated confirmation finds it taken).
        const [course] = await withUniqueConflict(
          () =>
            tx
              .insert(courses)
              .values({ termId: term.id, programId: program.id, templateId: null, templateVersionId: null, code: body.code, title: body.title ?? plan.title, description: plan.description, status: 'draft' })
              .returning(),
          'courses_term_id_code_unique',
          'COURSE_CODE_TAKEN',
          'A course with this code already exists in the term.',
        );
        if (!course) throw new Error('Course was not created');
        const created = await reconstructCourse(tx, course.id, plan, userId, body.assignmentDueAt ?? null);
        await recordAudit(tx, request, {
          action: 'course.imported',
          entityType: 'course',
          entityId: course.id,
          before: null,
          after: {
            code: course.code,
            title: course.title,
            programId: course.programId,
            termId: course.termId,
            formatVersion: preview.formatVersion,
            contentHash: preview.contentHash,
            sourceCourseCode: preview.source.courseCode,
            versionPreference: body.versionPreference,
            ...created,
            skipped: preview.skipped.map(({ key, type, reason }) => ({ key, type, reason })),
          },
        });
        return { course, created };
      });

      return reply.code(201).send({
        course: { id: result.course.id, code: result.course.code, title: result.course.title, status: 'draft', programId: result.course.programId, termId: result.course.termId },
        created: result.created,
        skipped: preview.skipped,
        contentHash: preview.contentHash,
      });
    },
  );
};
