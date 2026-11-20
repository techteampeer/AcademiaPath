import { createHash, randomUUID } from 'node:crypto';
import multipart from '@fastify/multipart';
import { and, eq, max } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { recordAudit } from '../audit.js';
import { canInCourse, getCourseAccess, type CourseAccess, type CoursePermission } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import type { Database } from '../db/client.js';
import { activities, courseDocuments, documentSummaries, sections } from '../db/schema/index.js';
import { extractInWorker } from '../documents/extraction.js';
import {
  DOCUMENT_MEDIA_TYPES,
  formatFromFileName,
  REJECTION_STATUS,
  sanitizeFileName,
  type RejectionCode,
} from '../documents/formats.js';
import { buildStudyBrief } from '../documents/brief.js';
import { readDocumentConfig, type DocumentConfig } from '../documents/model.js';
import { acceptsUploads } from '../documents/readiness.js';
import { decideScan, type MalwareScanner } from '../documents/scanner.js';
import type { DocumentStorage } from '../documents/storage.js';
import type { DocumentSummaryProvider } from '../documents/summary.js';
import { ApiProblem } from '../http/errors.js';
import { readUploadedFile } from '../http/uploads.js';
import { courseActivityParamsSchema, courseSectionParamsSchema } from './activity-schemas.js';
import { findActivity } from './activities.js';
import { documentDetailSchema, studyBriefSchema } from './document-schemas.js';

type SectionParams = { id: string; sectionId: string };
type ActivityParams = { id: string; activityId: string };
type DocumentRow = typeof courseDocuments.$inferSelect;
type SummaryRow = typeof documentSummaries.$inferSelect;
type Executor = Pick<Database, 'select' | 'insert' | 'update'>;

export type DocumentRouteOptions = { storage: DocumentStorage; scanner: MalwareScanner; provider: DocumentSummaryProvider };

const notFound = (what: string) => new ApiProblem(404, 'NOT_FOUND', `${what} not found.`);
const forbidden = () => new ApiProblem(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
const MODE_LABELS: Record<string, string> = { mock: 'Mock AI summary — local demonstration' };

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** AP-040B: storage that cannot be used right now (missing or unwritable directory, not mounted when enforced, I/O errors). */
const storageUnavailable = () =>
  new ApiProblem(503, 'DOCUMENT_STORAGE_UNAVAILABLE', 'Document storage is temporarily unavailable. Try again later or contact an administrator.');
/** AP-040B: the record exists but its stored file does not: the file is never served, and the cause is logged. */
const fileMissing = () => new ApiProblem(500, 'DOCUMENT_FILE_MISSING', 'The stored file of this document is missing. Contact an administrator.');
/** AP-040B: the stored file no longer matches the SHA-256 recorded at upload: nothing is sent. */
const fileCorrupt = () => new ApiProblem(500, 'DOCUMENT_FILE_CORRUPT', 'The stored file of this document failed its integrity check and cannot be downloaded. Contact an administrator.');
const errorCode = (error: unknown) => (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN');

function presentSummary(row: SummaryRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    provider: { id: row.provider, mode: row.mode, label: MODE_LABELS[row.mode] ?? row.provider },
    strategy: row.strategy,
    points: row.points,
    sourceCharacterCount: row.sourceCharacterCount,
    createdAt: row.createdAt,
  };
}

function toDetail(courseId: string, activityId: string, document: DocumentRow, summary: SummaryRow | null, liveSummary: SummaryRow | null) {
  return {
    activityId,
    courseId,
    document: {
      id: document.id,
      fileName: document.fileName,
      format: document.format,
      byteSize: document.byteSize,
      uploadedAt: document.createdAt,
      extraction: {
        status: document.extractionStatus,
        detail: document.extractionDetail,
        characterCount: document.characterCount,
        segmentCount: document.segments.length,
        truncated: document.truncated,
      },
      malwareScan: { status: document.malwareScanStatus, scanner: document.malwareScanner },
      segments: document.segments,
    },
    summary: presentSummary(summary),
    liveSummary: presentSummary(liveSummary),
  };
}

/** `attachment` with an ASCII fallback and the UTF-8 name (RFC 6266 / RFC 8187). */
function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\%;]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** Display title from the optional `title` field, or the file name without its extension. */
function titleFrom(field: unknown, fileName: string): string {
  const value = field && typeof field === 'object' && 'value' in field && typeof field.value === 'string' ? field.value.trim() : '';
  if (value.length > 200) throw new ApiProblem(400, 'VALIDATION_ERROR', 'The title can have at most 200 characters.');
  return value || fileName.replace(/\.(pdf|docx|pptx)$/i, '').trim().slice(0, 200) || 'Document';
}

/**
 * Course documents (PDF, DOCX, PPTX) with extracted text and mock summaries. Uploads become `file`
 * activities and use the existing content review endpoints (submit, approve, return), so students only
 * ever see an approved document together with the approved summary revision.
 */
export const documentRoutes: FastifyPluginAsync<DocumentRouteOptions> = async (app, { storage, scanner, provider }) => {
  const { db, config } = app;
  const authenticated = { preValidation: [app.requireAuth] };
  // Guards run before the body is read, so unauthenticated or forged uploads are rejected first.
  const authenticatedWrite = { preValidation: [app.requireAuth, app.requireCsrf] };

  // Multipart parsing is registered for these routes only. One file part plus one optional `title` field.
  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: { fileSize: config.documents.maxUploadBytes, files: 1, fields: 1, parts: 2, fieldSize: 1024, fieldNameSize: 64, headerPairs: 50 },
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  async function courseAccess(request: FastifyRequest, courseId: string): Promise<CourseAccess> {
    const access = await getCourseAccess(db, getAuth(request).user, courseId);
    if (!access) throw notFound('Course');
    return access;
  }

  function requirePermission(access: CourseAccess, permission: CoursePermission) {
    if (!canInCourse(access, permission)) throw forbidden();
  }

  async function loadDocument(executor: Executor, activityId: string, documentId: string) {
    const [row] = await executor
      .select()
      .from(courseDocuments)
      .where(and(eq(courseDocuments.id, documentId), eq(courseDocuments.activityId, activityId)));
    if (!row) throw notFound('Document');
    return row;
  }

  async function loadSummary(executor: Executor, documentId: string, summaryId: string) {
    const [row] = await executor
      .select()
      .from(documentSummaries)
      .where(and(eq(documentSummaries.id, summaryId), eq(documentSummaries.documentId, documentId)));
    return row ?? null;
  }

  /**
   * The document version a caller may read: staff the working copy, students only the approved copy of approved,
   * visible documents in open sections (else 404 or 403 SECTION_LOCKED, as for any content).
   */
  async function readablePointer(request: FastifyRequest, params: ActivityParams) {
    const access = await courseAccess(request, params.id);
    const activity = await findActivity(db, access, params.activityId, false);
    if (activity.type !== 'file') throw notFound('Document');
    const staffView = canInCourse(access, 'content.viewUnapproved');
    const pointer = readDocumentConfig(staffView ? activity.config : activity.approvedConfig);
    if (!pointer) throw notFound('Document');
    return { access, activity, staffView, pointer };
  }

  /**
   * The version a caller may read. Staff get the working copy (plus the approved summary as
   * `liveSummary`); students get only the approved copy of approved, visible documents (else 404).
   */
  async function readableDocument(request: FastifyRequest, params: ActivityParams) {
    const { access, activity, staffView, pointer } = await readablePointer(request, params);
    const live = staffView ? readDocumentConfig(activity.approvedConfig) : null;
    const document = await loadDocument(db, activity.id, pointer.documentId);
    const summary = await loadSummary(db, document.id, pointer.summaryId);
    const liveSummary = live ? await loadSummary(db, live.documentId, live.summaryId) : null;
    return { access, activity, document, summary, liveSummary };
  }

  app.post<{ Params: SectionParams }>(
    '/courses/:id/sections/:sectionId/documents',
    { ...authenticatedWrite, schema: { params: courseSectionParamsSchema, response: { 201: documentDetailSchema } } },
    async (request, reply) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'content.edit');
      const { user } = getAuth(request);
      const [section] = await db
        .select({ id: sections.id })
        .from(sections)
        .where(and(eq(sections.id, request.params.sectionId), eq(sections.courseId, access.course.id)));
      if (!section) throw notFound('Section');
      // AP-040B: never accept a file that could not be kept (no storage directory, or not ready when enforced).
      if (config.documents.mountCheck !== 'off') {
        const readiness = await app.storageReadiness();
        if (!acceptsUploads(readiness)) {
          request.log.error({ storage: { status: readiness.status, directory: readiness.directory, access: readiness.access, mount: readiness.mount } }, 'Upload refused: document storage is not usable');
          throw storageUnavailable();
        }
      }
      if (!request.isMultipart()) {
        throw new ApiProblem(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload the document as multipart/form-data with a "file" field.');
      }
      const part = await request.file();
      if (!part || part.fieldname !== 'file') {
        part?.file.resume();
        throw new ApiProblem(400, 'VALIDATION_ERROR', 'Attach exactly one file in the "file" field.');
      }
      const fileName = sanitizeFileName(part.filename);

      /** Refused uploads are audited (who, which section, which file and why) and never stored. */
      const reject = async (code: RejectionCode | 'PAYLOAD_TOO_LARGE', message: string, byteSize: number | null, extra: Record<string, unknown> = {}) => {
        await recordAudit(db, request, {
          action: 'document.upload_rejected',
          entityType: 'section',
          entityId: section.id,
          before: null,
          after: { courseId: access.course.id, fileName, byteSize, code, ...extra },
        });
        return new ApiProblem(code === 'PAYLOAD_TOO_LARGE' ? 413 : REJECTION_STATUS[code], code, message);
      };

      const format = formatFromFileName(fileName);
      if (!format) {
        part.file.resume();
        throw await reject('UNSUPPORTED_FILE_TYPE', 'Only PDF (.pdf), Word (.docx) and PowerPoint (.pptx) files are accepted.', null);
      }
      const title = titleFrom(part.fields.title, fileName);
      // A file cut off at the limit is refused (and the refusal audited) before it is scanned, extracted, summarized or
      // stored: no document, activity, stored file or upload audit is ever created from incomplete bytes (AP-SEC-02).
      const limitMb = Math.round(config.documents.maxUploadBytes / (1024 * 1024));
      const bytes = await readUploadedFile(part, () => reject('PAYLOAD_TOO_LARGE', `The file exceeds the ${limitMb} MB upload limit.`, null));

      // AP-040E: the complete file is scanned before it is parsed or stored. Infected files are always refused; a file
      // that could not be verified is refused in strict mode, and kept as `not_scanned` (never clean) otherwise.
      const scanStarted = Date.now();
      const result = await scanner.scan(bytes, { fileName, format });
      const scan = decideScan(result, config.malwareScanning.enforcement);
      // Diagnostics only: ids, outcome and timing; never the file's name, content or storage key.
      const scanLog = {
        courseId: access.course.id,
        sectionId: section.id,
        malwareScan: {
          status: result.status,
          scanner: result.scanner,
          reason: 'reason' in result ? result.reason : undefined,
          signature: scan.action === 'reject_infected' ? scan.signature : undefined,
          byteSize: bytes.length,
          durationMs: Date.now() - scanStarted,
        },
      };
      if (scan.action === 'reject_infected') {
        request.log.warn(scanLog, 'Upload refused: the malware scanner detected a threat');
        throw await reject('MALWARE_DETECTED', 'The file was rejected by the malware scanner.', bytes.length, { malwareScan: { scanner: scan.scanner, signature: scan.signature } });
      }
      if (scan.action === 'refuse_unverified') {
        request.log.error(scanLog, 'Upload refused: the file could not be scanned for malware (strict enforcement)');
        throw await reject('MALWARE_SCAN_UNAVAILABLE', 'The file could not be checked for malware right now, so it was not accepted. Try again later.', bytes.length, {
          malwareScan: { scanner: scan.scanner, status: scan.status, reason: scan.reason },
        });
      }
      if (result.status !== 'clean' && result.status !== 'not_scanned') request.log.warn(scanLog, 'Upload accepted without a malware verdict (compatibility enforcement): recorded as not_scanned');
      const extraction = await extractInWorker(bytes, format, config.documents.extractionTimeoutMs);
      if (!extraction.ok) throw await reject(extraction.code, extraction.message, bytes.length);
      const summary = await provider.summarize({ segments: extraction.segments, revision: 1 });
      const digest = sha256(bytes);

      // Store the original only after it passed validation; remove it again if the database write fails.
      let storageKey: string;
      try {
        storageKey = await storage.put(bytes);
      } catch (error) {
        request.log.error({ courseId: access.course.id, sectionId: section.id, errorCode: errorCode(error) }, 'Upload failed: the file could not be stored');
        throw storageUnavailable();
      }
      try {
        const detail = await db.transaction(async (tx) => {
          // Lock the section so concurrent additions get distinct positions.
          const [locked] = await tx.select({ id: sections.id }).from(sections).where(eq(sections.id, section.id)).for('update');
          if (!locked) throw notFound('Section');
          const [{ last } = { last: null }] = await tx
            .select({ last: max(activities.position) })
            .from(activities)
            .where(eq(activities.sectionId, locked.id));
          const documentId = randomUUID();
          const summaryId = randomUUID();
          const activityConfig: DocumentConfig = { documentId, summaryId, summaryRevision: 1, fileName, format: extraction.format };
          const [activity] = await tx
            .insert(activities)
            .values({ sectionId: locked.id, type: 'file', title, config: activityConfig, position: (last ?? -1) + 1, reviewStatus: 'draft' })
            .returning();
          if (!activity) throw new Error('Document activity was not created');
          const [document] = await tx
            .insert(courseDocuments)
            .values({
              id: documentId,
              activityId: activity.id,
              storageKey,
              fileName,
              format: extraction.format,
              byteSize: bytes.length,
              sha256: digest,
              extractionStatus: extraction.status,
              extractionDetail: extraction.detail,
              segments: extraction.segments,
              characterCount: extraction.characterCount,
              truncated: extraction.truncated,
              // Only the policy's decision: `clean` exclusively for a verified clean scan.
              malwareScanStatus: scan.status,
              malwareScanner: scan.scanner,
              uploadedByUserId: user.id,
            })
            .returning();
          const [summaryRow] = await tx
            .insert(documentSummaries)
            .values({
              id: summaryId,
              documentId,
              revision: 1,
              provider: provider.id,
              mode: provider.mode,
              strategy: summary.strategy,
              status: summary.status,
              points: summary.points,
              sourceCharacterCount: extraction.characterCount,
              createdByUserId: user.id,
            })
            .returning();
          if (!document || !summaryRow) throw new Error('Document was not stored');
          await recordAudit(tx, request, {
            action: 'activity.created',
            entityType: 'activity',
            entityId: activity.id,
            before: null,
            after: { courseId: access.course.id, sectionId: locked.id, type: 'file', title, content: activityConfig, reviewStatus: 'draft' },
          });
          // Metadata only: the extracted text is not copied into the append-only audit log.
          await recordAudit(tx, request, {
            action: 'document.uploaded',
            entityType: 'document',
            entityId: document.id,
            before: null,
            after: {
              courseId: access.course.id,
              activityId: activity.id,
              fileName,
              format: document.format,
              byteSize: document.byteSize,
              sha256: digest,
              extractionStatus: document.extractionStatus,
              characterCount: document.characterCount,
              segmentCount: extraction.segments.length,
              truncated: document.truncated,
              malwareScan: { status: document.malwareScanStatus, scanner: document.malwareScanner },
            },
          });
          await recordAudit(tx, request, {
            action: 'document.summary_generated',
            entityType: 'document',
            entityId: document.id,
            before: null,
            after: { activityId: activity.id, summaryId, revision: 1, provider: provider.id, status: summary.status, pointCount: summary.points.length },
          });
          return toDetail(access.course.id, activity.id, document, summaryRow, null);
        });
        return reply.code(201).send(detail);
      } catch (error) {
        await storage.remove(storageKey).catch(() => undefined);
        throw error;
      }
    },
  );

  app.get<{ Params: ActivityParams }>(
    '/courses/:id/activities/:activityId/document',
    { ...authenticated, schema: { params: courseActivityParamsSchema, response: { 200: documentDetailSchema } } },
    async (request) => {
      const { access, activity, document, summary, liveSummary } = await readableDocument(request, request.params);
      return toDetail(access.course.id, activity.id, document, summary, liveSummary);
    },
  );

  app.post<{ Params: ActivityParams }>(
    '/courses/:id/activities/:activityId/document/summaries',
    { ...authenticatedWrite, schema: { params: courseActivityParamsSchema, response: { 201: documentDetailSchema } } },
    async (request, reply) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'content.edit');
      const { user } = getAuth(request);
      const detail = await db.transaction(async (tx) => {
        const current = await findActivity(tx, access, request.params.activityId, true);
        if (current.type !== 'file') throw notFound('Document');
        if (current.reviewStatus === 'submitted') {
          throw new ApiProblem(409, 'ACTIVITY_UNDER_REVIEW', 'Content that is waiting for review cannot be changed.');
        }
        const working = readDocumentConfig(current.config);
        if (!working) throw notFound('Document');
        const document = await loadDocument(tx, current.id, working.documentId);
        const [{ last } = { last: null }] = await tx
          .select({ last: max(documentSummaries.revision) })
          .from(documentSummaries)
          .where(eq(documentSummaries.documentId, document.id));
        const revision = (last ?? 0) + 1;
        const result = await provider.summarize({ segments: document.segments, revision });
        const [summaryRow] = await tx
          .insert(documentSummaries)
          .values({
            documentId: document.id,
            revision,
            provider: provider.id,
            mode: provider.mode,
            strategy: result.strategy,
            status: result.status,
            points: result.points,
            sourceCharacterCount: document.characterCount,
            createdByUserId: user.id,
          })
          .returning();
        if (!summaryRow) throw new Error('Summary was not stored');
        const config: DocumentConfig = { ...working, summaryId: summaryRow.id, summaryRevision: revision };
        // Like editing: approved content becomes a new draft revision; the approved live version
        // (and its summary) stays exactly as approved until this revision is approved.
        const reviewStatus = current.reviewStatus === 'returned' ? 'returned' : 'draft';
        const [updated] = await tx.update(activities).set({ config, reviewStatus }).where(eq(activities.id, current.id)).returning();
        if (!updated) throw new Error('Activity was not updated');
        await recordAudit(tx, request, {
          action: 'document.summary_generated',
          entityType: 'document',
          entityId: document.id,
          before: { activityId: current.id, summaryRevision: working.summaryRevision, reviewStatus: current.reviewStatus },
          after: {
            activityId: current.id,
            summaryId: summaryRow.id,
            revision,
            provider: provider.id,
            status: result.status,
            pointCount: result.points.length,
            reviewStatus,
          },
        });
        const live = readDocumentConfig(updated.approvedConfig);
        const liveSummary = live ? await loadSummary(tx, live.documentId, live.summaryId) : null;
        return toDetail(access.course.id, current.id, document, summaryRow, liveSummary);
      });
      return reply.code(201).send(detail);
    },
  );

  /**
   * AP-031D study brief of the document version the caller may read, computed on request from its stored extracted
   * text: no re-extraction, no file read, no model, nothing stored. The same access rules as reading the document.
   */
  app.get<{ Params: ActivityParams }>(
    '/courses/:id/activities/:activityId/document/brief',
    { ...authenticated, schema: { params: courseActivityParamsSchema, response: { 200: studyBriefSchema } } },
    async (request) => {
      const { access, activity, staffView, pointer } = await readablePointer(request, request.params);
      const [document] = await db
        .select({
          id: courseDocuments.id,
          fileName: courseDocuments.fileName,
          format: courseDocuments.format,
          extractionStatus: courseDocuments.extractionStatus,
          extractionDetail: courseDocuments.extractionDetail,
          characterCount: courseDocuments.characterCount,
          truncated: courseDocuments.truncated,
          segments: courseDocuments.segments,
        })
        .from(courseDocuments)
        .where(and(eq(courseDocuments.id, pointer.documentId), eq(courseDocuments.activityId, activity.id)));
      if (!document) throw notFound('Document');
      // Students see the approved title; staff the working copy's, matching the document they read.
      const title = (staffView ? activity.title : activity.approvedTitle) ?? activity.title;
      const brief = buildStudyBrief({
        title,
        fileName: document.fileName,
        format: document.format,
        extractionStatus: document.extractionStatus,
        extractionDetail: document.extractionDetail,
        truncated: document.truncated,
        segments: document.segments,
      });
      return {
        activityId: activity.id,
        courseId: access.course.id,
        title,
        version: staffView ? ('working' as const) : ('approved' as const),
        generator: { id: 'study-brief-v1', mode: 'extractive' as const },
        document: {
          id: document.id,
          fileName: document.fileName,
          format: document.format,
          extraction: { status: document.extractionStatus, characterCount: document.characterCount, segmentCount: document.segments.length, truncated: document.truncated },
        },
        brief,
      };
    },
  );

  app.get<{ Params: ActivityParams }>(
    '/courses/:id/activities/:activityId/document/file',
    { ...authenticated, schema: { params: courseActivityParamsSchema } },
    async (request, reply) => {
      // Access is decided first (unchanged); storage is only touched for callers who may read this document.
      const { access, activity, document } = await readableDocument(request, request.params);
      // Diagnostics name the records only: never the storage key, a path or the file's contents.
      const where = { courseId: access.course.id, activityId: activity.id, documentId: document.id };
      let bytes: Buffer;
      try {
        bytes = await storage.read(document.storageKey);
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT') {
          request.log.error({ ...where, problem: 'DOCUMENT_FILE_MISSING' }, 'Stored document file is missing');
          throw fileMissing();
        }
        request.log.error({ ...where, problem: 'DOCUMENT_STORAGE_UNAVAILABLE', errorCode: code }, 'Stored document file could not be read');
        throw storageUnavailable();
      }
      if (bytes.length !== document.byteSize || sha256(bytes) !== document.sha256) {
        request.log.error({ ...where, problem: 'DOCUMENT_FILE_CORRUPT', storedBytes: bytes.length, expectedBytes: document.byteSize }, 'Stored document file failed its integrity check');
        throw fileCorrupt();
      }
      return reply
        .header('content-type', DOCUMENT_MEDIA_TYPES[document.format])
        .header('content-disposition', contentDisposition(document.fileName))
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .send(bytes);
    },
  );
};
