import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { primaryId } from './columns.js';
import { activities } from './content.js';
import { documentExtractionStatusEnum, documentFormatEnum, documentSummaryStatusEnum, malwareScanStatusEnum } from './enums.js';
import { users } from './users.js';

/** One block of extracted text: a PDF page, a PPTX slide or a DOCX paragraph. */
export type DocumentSegment = { index: number; kind: 'page' | 'slide' | 'paragraph'; label: string; text: string };

/** A summary point and the original-text evidence it was taken from. */
export type DocumentSummaryPoint = { text: string; evidence: { segmentIndex: number; label: string; quote: string } };

/**
 * An uploaded file attached to a `file` activity. Rows are immutable (enforced by a trigger): the
 * activity's working copy and approved copy point at a specific document, so nothing a reviewer
 * approved can change afterwards. The original bytes live in private local storage under the opaque
 * `storage_key`; PostgreSQL holds metadata and extracted text only.
 */
export const courseDocuments = pgTable(
  'course_documents',
  {
    id: primaryId(),
    activityId: uuid('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'cascade' }),
    /** Server-generated file name in storage; never derived from user input. */
    storageKey: uuid('storage_key').notNull().unique(),
    /** Sanitized original name, for display and downloads only. */
    fileName: text('file_name').notNull(),
    format: documentFormatEnum('format').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    extractionStatus: documentExtractionStatusEnum('extraction_status').notNull(),
    extractionDetail: text('extraction_detail'),
    segments: jsonb('segments').$type<DocumentSegment[]>().notNull(),
    characterCount: integer('character_count').notNull(),
    /** True when extraction stopped at a size limit (the stored text is a prefix of the document). */
    truncated: boolean('truncated').notNull().default(false),
    malwareScanStatus: malwareScanStatusEnum('malware_scan_status').notNull(),
    malwareScanner: text('malware_scanner').notNull(),
    uploadedByUserId: uuid('uploaded_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('course_documents_activity_id_idx').on(t.activityId),
    check('course_documents_byte_size_check', sql`${t.byteSize} > 0`),
    check('course_documents_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('course_documents_character_count_check', sql`${t.characterCount} >= 0`),
    check('course_documents_segments_check', sql`jsonb_typeof(${t.segments}) = 'array'`),
  ],
);

/**
 * Summary revisions of a document (immutable). Refreshing creates the next revision; the activity's
 * working copy points at the newest one, and students only ever see the revision that was approved.
 */
export const documentSummaries = pgTable(
  'document_summaries',
  {
    id: primaryId(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => courseDocuments.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    /** Provider identifier, e.g. `mock-extractive-v1`. */
    provider: text('provider').notNull(),
    /** `mock` for the local simulated provider. */
    mode: text('mode').notNull(),
    strategy: text('strategy').notNull(),
    status: documentSummaryStatusEnum('status').notNull(),
    points: jsonb('points').$type<DocumentSummaryPoint[]>().notNull(),
    sourceCharacterCount: integer('source_character_count').notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('document_summaries_document_revision_unique').on(t.documentId, t.revision),
    check('document_summaries_revision_check', sql`${t.revision} >= 1`),
    check('document_summaries_points_check', sql`jsonb_typeof(${t.points}) = 'array'`),
    check('document_summaries_status_points_check', sql`${t.status} = 'ready' OR jsonb_array_length(${t.points}) = 0`),
  ],
);
