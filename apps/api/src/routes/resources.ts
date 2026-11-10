import { and, asc, count, eq, exists, isNotNull, max, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { recordAudit } from '../audit.js';
import { canInCourse, getCourseAccess, type CourseAccess } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import type { Database } from '../db/client.js';
import { activities, resourceFolders, sections } from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';
import { assertSectionOpen, READING_TYPES } from '../progress/model.js';
import { findActivity } from './activities.js';
import { courseActivityParamsSchema, courseSectionParamsSchema } from './activity-schemas.js';
import {
  activityOrderResultSchema,
  activityOrderSchema,
  activityOrganizationSchema,
  folderOrderSchema,
  folderParamsSchema,
  resourceFolderInputSchema,
  resourceFolderListSchema,
  resourceFolderSchema,
} from './resource-schemas.js';

type SectionParams = { id: string; sectionId: string };
type FolderParams = { id: string; folderId: string };
type ActivityParams = { id: string; activityId: string };
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const notFound = (what: string) => new ApiProblem(404, 'NOT_FOUND', `${what} not found.`);
const forbidden = () => new ApiProblem(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
const stale = () => new ApiProblem(409, 'RESOURCE_ORDER_STALE', 'The content changed in the meantime. Reload the course and try again.');

const folderColumns = { id: resourceFolders.id, sectionId: resourceFolders.sectionId, title: resourceFolders.title, position: resourceFolders.position };
const organizationResultSchema = {
  type: 'object',
  required: ['id', 'folderId', 'isVisible'],
  additionalProperties: false,
  properties: { id: { type: 'string', format: 'uuid' }, folderId: { type: ['string', 'null'], format: 'uuid' }, isVisible: { type: 'boolean' } },
} as const;

/**
 * Learning-resource organization (AP-021). Folders group reading activities (lessons, links, documents)
 * within a section; editors also order a section's activities and show or hide reading activities.
 * Content itself (titles, URLs, kinds) still changes only through the review workflow, and students
 * only ever see approved, visible activities in visible, open sections.
 */
export const resourceRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const authenticated = { preValidation: [app.requireAuth] };
  const authenticatedWrite = { preValidation: [app.requireAuth, app.requireCsrf] };

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  /** Default deny: 404 unless the caller may see the course (draft courses are invisible to students). */
  async function courseAccess(request: FastifyRequest, courseId: string): Promise<CourseAccess> {
    const access = await getCourseAccess(db, getAuth(request).user, courseId);
    if (!access) throw notFound('Course');
    return access;
  }

  /** Organizing content needs the same permission as editing it (instructors, design team, administrators). */
  const requireEditor = (access: CourseAccess) => {
    if (!canInCourse(access, 'content.edit')) throw forbidden();
  };

  /** The section, row-locked: serializes position changes (activity creation locks it the same way). */
  async function lockSection(tx: Tx, access: CourseAccess, sectionId: string) {
    const [section] = await tx
      .select({ id: sections.id })
      .from(sections)
      .where(and(eq(sections.id, sectionId), eq(sections.courseId, access.course.id)))
      .for('update');
    if (!section) throw notFound('Section');
    return section;
  }

  async function lockFolder(tx: Tx, access: CourseAccess, folderId: string, mode: 'update' | 'share') {
    const [folder] = await tx
      .select(folderColumns)
      .from(resourceFolders)
      .where(and(eq(resourceFolders.id, folderId), eq(resourceFolders.courseId, access.course.id)))
      .for(mode);
    if (!folder) throw notFound('Folder');
    return folder;
  }

  // ---- Folders ----

  app.get<{ Params: SectionParams }>(
    '/courses/:id/sections/:sectionId/resource-folders',
    { ...authenticated, schema: { params: courseSectionParamsSchema, response: { 200: resourceFolderListSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      const staffView = canInCourse(access, 'content.viewUnapproved');
      const [section] = await db
        .select({ id: sections.id, isVisible: sections.isVisible })
        .from(sections)
        .where(and(eq(sections.id, request.params.sectionId), eq(sections.courseId, access.course.id)));
      if (!section || (!section.isVisible && !canInCourse(access, 'sections.viewHidden'))) throw notFound('Section');
      await assertSectionOpen(db, access, section.id);
      // Students only see folders that hold at least one approved, visible activity (no empty or draft-only folders).
      const studentVisible = exists(
        db
          .select({ one: sql`1` })
          .from(activities)
          .where(and(sql`${activities.folderId} = "resource_folders"."id"`, eq(activities.isVisible, true), isNotNull(activities.approvedConfig))),
      );
      const items = await db
        .select(folderColumns)
        .from(resourceFolders)
        .where(and(eq(resourceFolders.sectionId, section.id), staffView ? undefined : studentVisible))
        .orderBy(asc(resourceFolders.position), asc(resourceFolders.id));
      return { items };
    },
  );

  app.post<{ Params: SectionParams; Body: { title: string } }>(
    '/courses/:id/sections/:sectionId/resource-folders',
    { ...authenticatedWrite, schema: { params: courseSectionParamsSchema, body: resourceFolderInputSchema, response: { 201: resourceFolderSchema } } },
    async (request, reply) => {
      const access = await courseAccess(request, request.params.id);
      requireEditor(access);
      const folder = await db.transaction(async (tx) => {
        const section = await lockSection(tx, access, request.params.sectionId);
        const [{ last } = { last: null }] = await tx
          .select({ last: max(resourceFolders.position) })
          .from(resourceFolders)
          .where(eq(resourceFolders.sectionId, section.id));
        const [row] = await tx
          .insert(resourceFolders)
          .values({ courseId: access.course.id, sectionId: section.id, title: request.body.title.trim(), position: (last ?? -1) + 1, createdByUserId: access.userId })
          .returning(folderColumns);
        if (!row) throw new Error('Folder was not created');
        await recordAudit(tx, request, {
          action: 'resource_folder.created',
          entityType: 'resource_folder',
          entityId: row.id,
          before: null,
          after: { courseId: access.course.id, sectionId: section.id, title: row.title, position: row.position },
        });
        return row;
      });
      return reply.code(201).send(folder);
    },
  );

  app.put<{ Params: FolderParams; Body: { title: string } }>(
    '/courses/:id/resource-folders/:folderId',
    { ...authenticatedWrite, schema: { params: folderParamsSchema, body: resourceFolderInputSchema, response: { 200: resourceFolderSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireEditor(access);
      return db.transaction(async (tx) => {
        const current = await lockFolder(tx, access, request.params.folderId, 'update');
        const [row] = await tx
          .update(resourceFolders)
          .set({ title: request.body.title.trim() })
          .where(eq(resourceFolders.id, current.id))
          .returning(folderColumns);
        if (!row) throw new Error('Folder was not updated');
        await recordAudit(tx, request, {
          action: 'resource_folder.renamed',
          entityType: 'resource_folder',
          entityId: row.id,
          before: { title: current.title },
          after: { title: row.title },
        });
        return row;
      });
    },
  );

  app.delete<{ Params: FolderParams }>(
    '/courses/:id/resource-folders/:folderId',
    { ...authenticatedWrite, schema: { params: folderParamsSchema } },
    async (request, reply) => {
      const access = await courseAccess(request, request.params.id);
      requireEditor(access);
      await db.transaction(async (tx) => {
        const current = await lockFolder(tx, access, request.params.folderId, 'update');
        // Nothing is ever deleted with a folder: it must be empty (the foreign key enforces this too).
        const [{ items } = { items: 0 }] = await tx.select({ items: count() }).from(activities).where(eq(activities.folderId, current.id));
        if (items > 0) throw new ApiProblem(409, 'RESOURCE_FOLDER_NOT_EMPTY', 'Move or remove the folder’s content before deleting it.');
        await tx.delete(resourceFolders).where(eq(resourceFolders.id, current.id));
        await recordAudit(tx, request, {
          action: 'resource_folder.deleted',
          entityType: 'resource_folder',
          entityId: current.id,
          before: { courseId: access.course.id, sectionId: current.sectionId, title: current.title },
          after: null,
        });
      });
      return reply.code(204).send();
    },
  );

  app.put<{ Params: SectionParams; Body: { folderIds: string[] } }>(
    '/courses/:id/sections/:sectionId/resource-folders/order',
    { ...authenticatedWrite, schema: { params: courseSectionParamsSchema, body: folderOrderSchema, response: { 200: resourceFolderListSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireEditor(access);
      return db.transaction(async (tx) => {
        const section = await lockSection(tx, access, request.params.sectionId);
        const current = await tx.select(folderColumns).from(resourceFolders).where(eq(resourceFolders.sectionId, section.id)).orderBy(asc(resourceFolders.position), asc(resourceFolders.id));
        const { folderIds } = request.body;
        // The request must name every folder of the section exactly once (otherwise it was based on stale data).
        if (folderIds.length !== current.length || !current.every((folder) => folderIds.includes(folder.id))) throw stale();
        for (const [position, id] of folderIds.entries()) {
          await tx.update(resourceFolders).set({ position }).where(eq(resourceFolders.id, id));
        }
        await recordAudit(tx, request, {
          action: 'resource_folder.reordered',
          entityType: 'section',
          entityId: section.id,
          before: { folderIds: current.map((folder) => folder.id) },
          after: { folderIds },
        });
        return { items: await tx.select(folderColumns).from(resourceFolders).where(eq(resourceFolders.sectionId, section.id)).orderBy(asc(resourceFolders.position), asc(resourceFolders.id)) };
      });
    },
  );

  // ---- Activities: order, folder placement and visibility ----

  app.put<{ Params: SectionParams; Body: { activityIds: string[] } }>(
    '/courses/:id/sections/:sectionId/activities/order',
    { ...authenticatedWrite, schema: { params: courseSectionParamsSchema, body: activityOrderSchema, response: { 200: activityOrderResultSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireEditor(access);
      return db.transaction(async (tx) => {
        const section = await lockSection(tx, access, request.params.sectionId);
        const current = await tx
          .select({ id: activities.id })
          .from(activities)
          .where(eq(activities.sectionId, section.id))
          .orderBy(asc(activities.position), asc(activities.id));
        const { activityIds } = request.body;
        if (activityIds.length !== current.length || !current.every((activity) => activityIds.includes(activity.id))) throw stale();
        for (const [position, id] of activityIds.entries()) {
          await tx.update(activities).set({ position }).where(and(eq(activities.id, id), eq(activities.sectionId, section.id)));
        }
        await recordAudit(tx, request, {
          action: 'activity.reordered',
          entityType: 'section',
          entityId: section.id,
          before: { activityIds: current.map((activity) => activity.id) },
          after: { activityIds },
        });
        return { activityIds };
      });
    },
  );

  app.put<{ Params: ActivityParams; Body: { folderId?: string | null; isVisible?: boolean } }>(
    '/courses/:id/activities/:activityId/organization',
    { ...authenticatedWrite, schema: { params: courseActivityParamsSchema, body: activityOrganizationSchema, response: { 200: organizationResultSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireEditor(access);
      const { folderId, isVisible } = request.body;
      return db.transaction(async (tx) => {
        const current = await findActivity(tx, access, request.params.activityId, true);
        // Only reading resources are organized here; quizzes and assignments keep their grading rules untouched.
        if (!(READING_TYPES as readonly string[]).includes(current.type)) {
          throw new ApiProblem(422, 'RESOURCE_NOT_ORGANIZABLE', 'Only lessons, links and documents can be placed in folders or shown and hidden here.');
        }
        if (folderId) {
          const folder = await lockFolder(tx, access, folderId, 'share');
          if (folder.sectionId !== current.sectionId) {
            throw new ApiProblem(422, 'RESOURCE_FOLDER_NOT_FOUND', 'The folder does not exist in this activity’s section.');
          }
        }
        const next = { folderId: folderId === undefined ? current.folderId : folderId, isVisible: isVisible ?? current.isVisible };
        const [row] = await tx
          .update(activities)
          .set(next)
          .where(eq(activities.id, current.id))
          .returning({ id: activities.id, folderId: activities.folderId, isVisible: activities.isVisible });
        if (!row) throw new Error('Activity was not updated');
        await recordAudit(tx, request, {
          action: 'activity.organized',
          entityType: 'activity',
          entityId: row.id,
          before: { folderId: current.folderId, isVisible: current.isVisible },
          after: { folderId: row.folderId, isVisible: row.isVisible },
        });
        return row;
      });
    },
  );
};

