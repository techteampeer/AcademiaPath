/**
 * AP-038C2B: restores a validated AcademiaPath course archive (AP-038C1C export, AP-038C2A validation) as a NEW draft
 * course, documents included. No route exposes it yet (the API and UI are the next milestone). It reuses the JSON
 * import's plan and reconstruction (AP-038B) and the document upload pipeline (scan, extraction in the isolated worker,
 * extractive summary, storage), so an imported course is exactly what staff would have built by hand: draft content in
 * review, never approved, published or visible to students.
 *
 * Order of work, so a failure can never leave a partially visible course:
 * 1. The caller must be an active administrator (as for the JSON import).
 * 2. The whole archive is validated (`readCourseArchive`): nothing is written for an invalid archive.
 * 3. The plan, the placement (program, term, free course code), and every document are prepared in memory: the bytes
 *    are rechecked against the validated SHA-256, scanned, extracted and summarized. A rejected document stops the
 *    import before anything is stored.
 * 4. Files are written to document storage, each read back and verified. Storage cannot take part in a database
 *    transaction, so these files are not referenced by anything yet: they are invisible.
 * 5. One database transaction creates the draft course, its content and the document records that reference the
 *    files, plus the audit records. It either commits completely or not at all.
 * 6. If step 4 or 5 fails, every file written in step 4 is removed again. A file that cannot be removed, or files left
 *    by a process crash between steps 4 and 5, are unreferenced and therefore never served; the read-only storage
 *    audit (`pnpm storage:audit`) reports them as orphaned for an administrator to remove. Errors report how many files
 *    could not be removed, never their storage keys.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { recordAuditAs } from '../audit.js';
import type { Database } from '../db/client.js';
import { withUniqueConflict } from '../db/errors.js';
import { courseDocuments, courses, documentSummaries, programs, terms, users, type DocumentFormat } from '../db/schema/index.js';
import type { ExtractionOutcome } from '../documents/extract.js';
import { sanitizeFileName } from '../documents/formats.js';
import type { MalwareScanner, MalwareScanResult } from '../documents/scanner.js';
import type { DocumentStorage } from '../documents/storage.js';
import type { DocumentSummaryProvider, SummaryOutput } from '../documents/summary.js';
import { ApiProblem } from '../http/errors.js';
import { readCourseArchive, type ArchiveValidationReport } from './archive-validation.js';
import { analyzePackage, type ImportPreview, type PlannedActivity, type VersionPreference } from './course-import.js';
import { reconstructCourse } from './course-reconstruct.js';

export type ArchiveImportDeps = {
  db: Database;
  storage: Pick<DocumentStorage, 'put' | 'read' | 'remove'>;
  scanner: MalwareScanner;
  provider: DocumentSummaryProvider;
  /** Validates and extracts a document in the isolated worker: the upload pipeline's `extractInWorker`. */
  extract: (bytes: Uint8Array, format: DocumentFormat) => Promise<ExtractionOutcome>;
};

export type ArchiveImportInput = {
  archive: Buffer;
  actor: { userId: string; ip: string | null };
  programId: string;
  termId: string;
  code: string;
  title?: string;
  versionPreference?: VersionPreference;
  acknowledgeSkipped?: boolean;
  assignmentDueAt?: string;
};

export type ArchiveImportProblem =
  | 'FORBIDDEN'
  | 'ARCHIVE_INVALID'
  | 'ACKNOWLEDGEMENT_REQUIRED'
  | 'DUE_DATE_REQUIRED'
  | 'PROGRAM_NOT_FOUND'
  | 'PROGRAM_INACTIVE'
  | 'TERM_NOT_FOUND'
  | 'COURSE_CODE_TAKEN'
  | 'DOCUMENT_REJECTED'
  | 'STORAGE_FAILED'
  | 'IMPORT_FAILED';

/** Why nothing was imported. Never carries a storage key, path or document content. */
export class ArchiveImportError extends Error {
  constructor(
    readonly problem: ArchiveImportProblem,
    message: string,
    readonly detail: {
      report?: ArchiveValidationReport;
      assetKey?: string;
      documentCode?: string;
    } = {},
    /** Files written before the failure that could not be removed again (unreferenced; see `pnpm storage:audit`). */
    public orphanedFiles = 0,
  ) {
    super(message);
    this.name = 'ArchiveImportError';
  }
}

export type ArchiveImportResult = {
  course: {
    id: string;
    code: string;
    title: string;
    status: 'draft';
    programId: string | null;
    termId: string;
  };
  created: {
    units: number;
    folders: number;
    prerequisites: number;
    activities: number;
    questions: number;
    documents: number;
  };
  skipped: ImportPreview['skipped'];
  contentHash: string | null;
};

type PreparedDocument = {
  bytes: Buffer;
  format: DocumentFormat;
  sha256: string;
  scan: MalwareScanResult;
  extraction: Extract<ExtractionOutcome, { ok: true }>;
  summary: SummaryOutput;
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Imports one archive as a new draft course. Throws ArchiveImportError (nothing created) or returns the new course. */
export async function importCourseArchive(deps: ArchiveImportDeps, input: ArchiveImportInput): Promise<ArchiveImportResult> {
  const { db, storage } = deps;
  const preference = input.versionPreference ?? 'approved';
  const written: string[] = [];
  const storedFor = new Map<string, string>();
  const removeWritten = async () => {
    let failed = 0;
    for (const key of written) await storage.remove(key).catch(() => (failed += 1));
    return failed;
  };
  // Every failure, expected or not, ends in the same place: remove what was written, report without internals.
  try {
    // 1. Who: an active administrator (the future route checks this too).
    const [actor] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.actor.userId), eq(users.systemRole, 'administrator'), eq(users.isActive, true)));
    if (!actor) throw new ArchiveImportError('FORBIDDEN', 'Only administrators can import course archives.');

    // 2. The whole archive, before anything else.
    const { report, contents } = await readCourseArchive(input.archive);
    if (!contents) throw new ArchiveImportError('ARCHIVE_INVALID', 'The archive is not a valid AcademiaPath course archive.', { report });

    // 3a. The plan: the JSON import's analysis, with the verified bundled files.
    const analysis = analyzePackage(contents.packageJson, preference, {
      bundledAssets: new Set(contents.assets.keys()),
    });
    if (analysis.fatal || !analysis.plan) throw new ArchiveImportError('ARCHIVE_INVALID', 'The course package in the archive is not valid.', { report });
    const { preview, plan } = analysis;
    if (preview.requiresAcknowledgement && !input.acknowledgeSkipped) {
      throw new ArchiveImportError(
        'ACKNOWLEDGEMENT_REQUIRED',
        `${preview.skipped.length} activities cannot be imported (types that are not portable yet). Confirm that the course may be imported without them.`,
      );
    }
    if (preview.requiresDueDate && !input.assignmentDueAt) {
      throw new ArchiveImportError('DUE_DATE_REQUIRED', 'Choose a due date for the imported assignments: the dates in the package belong to the source term.');
    }
    const documentActivities = plan.units
      .flatMap((unit) => unit.activities)
      .filter(
        (
          activity,
        ): activity is PlannedActivity & {
          document: NonNullable<PlannedActivity['document']>;
        } => Boolean(activity.document),
      );

    // 3b. Placement, checked before any file is stored (and again inside the transaction).
    const placement = async (reader: Pick<Database, 'select'>) => {
      const [program] = await reader.select().from(programs).where(eq(programs.id, input.programId));
      if (!program) throw new ArchiveImportError('PROGRAM_NOT_FOUND', 'The program does not exist.');
      if (!program.isActive) throw new ArchiveImportError('PROGRAM_INACTIVE', 'The program is not active.');
      const [term] = await reader.select({ id: terms.id }).from(terms).where(eq(terms.id, input.termId));
      if (!term) throw new ArchiveImportError('TERM_NOT_FOUND', 'The term does not exist.');
      const [taken] = await reader
        .select({ id: courses.id })
        .from(courses)
        .where(and(eq(courses.termId, term.id), eq(courses.code, input.code)));
      if (taken) throw new ArchiveImportError('COURSE_CODE_TAKEN', 'A course with this code already exists in the term.');
      return { program, term };
    };
    await placement(db);

    // 3c. Every document, in memory: the validated bytes rechecked, scanned, extracted and summarized.
    const prepared = new Map<string, PreparedDocument>();
    for (const { document } of documentActivities) {
      if (prepared.has(document.assetKey)) continue;
      const asset = contents.assets.get(document.assetKey);
      if (!asset || asset.bytes.length !== asset.byteSize || sha256(asset.bytes) !== asset.sha256 || asset.format !== document.format) {
        throw new ArchiveImportError('ARCHIVE_INVALID', 'A document changed after the archive was validated.', { assetKey: document.assetKey });
      }
      const fileName = sanitizeFileName(document.fileName);
      const scan = await deps.scanner.scan(asset.bytes, {
        fileName,
        format: document.format,
      });
      if (scan.status === 'infected')
        throw new ArchiveImportError('DOCUMENT_REJECTED', 'A document was rejected by the malware scanner.', { assetKey: document.assetKey, documentCode: 'MALWARE_DETECTED' });
      const extraction = await deps.extract(asset.bytes, document.format);
      if (!extraction.ok) throw new ArchiveImportError('DOCUMENT_REJECTED', `A document was rejected: ${extraction.message}`, { assetKey: document.assetKey, documentCode: extraction.code });
      const summary = await deps.provider.summarize({
        segments: extraction.segments,
        revision: 1,
      });
      prepared.set(document.assetKey, {
        bytes: asset.bytes,
        format: document.format,
        sha256: asset.sha256,
        scan,
        extraction,
        summary,
      });
    }

    // 4. Files, one stored copy per document activity, each read back and verified. Unreferenced until step 5 commits.
    for (const activity of documentActivities) {
      const document = prepared.get(activity.document.assetKey)!;
      let key: string;
      try {
        key = await storage.put(document.bytes);
      } catch {
        throw new ArchiveImportError('STORAGE_FAILED', 'A document file could not be stored.', { assetKey: activity.document.assetKey });
      }
      written.push(key);
      storedFor.set(activity.key, key);
      const stored = await storage.read(key).catch(() => null);
      if (!stored || stored.length !== document.bytes.length || sha256(stored) !== document.sha256) {
        throw new ArchiveImportError('STORAGE_FAILED', 'A stored document file did not match the archive.', { assetKey: activity.document.assetKey });
      }
    }

    // 5. One transaction: the draft course, its content, the document records and the audit trail.
    return await db.transaction(async (tx) => {
      const { program, term } = await placement(tx);
      const [course] = await withUniqueConflict(
        () =>
          tx
            .insert(courses)
            .values({
              termId: term.id,
              programId: program.id,
              templateId: null,
              templateVersionId: null,
              code: input.code,
              title: input.title ?? plan.title,
              description: plan.description,
              status: 'draft',
            })
            .returning(),
        'courses_term_id_code_unique',
        'COURSE_CODE_TAKEN',
        'A course with this code already exists in the term.',
      );
      if (!course) throw new Error('Course was not created');
      const restored: Array<Record<string, unknown>> = [];
      const created = (await reconstructCourse(tx, course.id, plan, input.actor.userId, input.assignmentDueAt ?? null, async (inner, target) => {
        const document = prepared.get(target.assetKey)!;
        const { extraction, summary, scan } = document;
        const fileName = sanitizeFileName(target.fileName);
        await inner.insert(courseDocuments).values({
          id: target.documentId,
          activityId: target.activityId,
          storageKey: storedFor.get(target.activityKey)!,
          fileName,
          format: extraction.format,
          byteSize: document.bytes.length,
          sha256: document.sha256,
          extractionStatus: extraction.status,
          extractionDetail: extraction.detail,
          segments: extraction.segments,
          characterCount: extraction.characterCount,
          truncated: extraction.truncated,
          // Never "clean" unless a scanner said so.
          malwareScanStatus: scan.status === 'clean' ? 'clean' : 'not_scanned',
          malwareScanner: scan.scanner,
          uploadedByUserId: input.actor.userId,
        });
        await inner.insert(documentSummaries).values({
          id: target.summaryId,
          documentId: target.documentId,
          revision: 1,
          provider: deps.provider.id,
          mode: deps.provider.mode,
          strategy: summary.strategy,
          status: summary.status,
          points: summary.points,
          sourceCharacterCount: extraction.characterCount,
          createdByUserId: input.actor.userId,
        });
        restored.push({
          assetKey: target.assetKey,
          activityId: target.activityId,
          documentId: target.documentId,
          fileName,
          format: extraction.format,
          byteSize: document.bytes.length,
          sha256: document.sha256,
          extractionStatus: extraction.status,
          malwareScan: {
            status: scan.status === 'clean' ? 'clean' : 'not_scanned',
            scanner: scan.scanner,
          },
        });
      })) as ArchiveImportResult['created'];
      // Metadata only: no storage keys and no extracted text in the append-only audit log.
      await recordAuditAs(tx, input.actor, {
        action: 'course.imported',
        entityType: 'course',
        entityId: course.id,
        before: null,
        after: {
          source: 'archive',
          code: course.code,
          title: course.title,
          programId: course.programId,
          termId: course.termId,
          formatVersion: preview.formatVersion,
          contentHash: preview.contentHash,
          sourceCourseCode: preview.source.courseCode,
          versionPreference: preference,
          ...created,
          documents: restored,
          skipped: preview.skipped.map(({ key, type, reason }) => ({
            key,
            type,
            reason,
          })),
        },
      });
      return {
        course: {
          id: course.id,
          code: course.code,
          title: course.title,
          status: 'draft' as const,
          programId: course.programId,
          termId: course.termId,
        },
        created,
        skipped: preview.skipped,
        contentHash: preview.contentHash,
      };
    });
  } catch (error) {
    const orphanedFiles = await removeWritten();
    if (error instanceof ArchiveImportError) {
      error.orphanedFiles = orphanedFiles;
      throw error;
    }
    if (error instanceof ApiProblem && error.code === 'COURSE_CODE_TAKEN') throw new ArchiveImportError('COURSE_CODE_TAKEN', error.message, {}, orphanedFiles);
    // Unexpected: nothing was created; the cause stays server-side.
    throw Object.assign(new ArchiveImportError('IMPORT_FAILED', 'The import could not be completed; nothing was created.', {}, orphanedFiles), { cause: error });
  }
}
