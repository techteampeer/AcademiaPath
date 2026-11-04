import type { ActivityConfig, DocumentFormat } from '../db/schema/index.js';

/**
 * `config` of a `file` activity: pointers to one immutable document and one immutable summary
 * revision (plus display fields). Approval copies it to `approved_config`, which freezes exactly the
 * document and summary revision the reviewer saw.
 */
export type DocumentConfig = { documentId: string; summaryId: string; summaryRevision: number; fileName: string; format: DocumentFormat };

export function readDocumentConfig(config: ActivityConfig | null): DocumentConfig | null {
  if (!config) return null;
  const { documentId, summaryId, summaryRevision, fileName, format } = config as Partial<DocumentConfig>;
  if (typeof documentId !== 'string' || typeof summaryId !== 'string' || typeof summaryRevision !== 'number' || typeof fileName !== 'string') return null;
  if (format !== 'pdf' && format !== 'docx' && format !== 'pptx') return null;
  return { documentId, summaryId, summaryRevision, fileName, format };
}

/** What activity listings expose for a document (the document endpoint returns text and summaries). */
export function presentDocumentContent(config: ActivityConfig | null) {
  const value = readDocumentConfig(config);
  return value ? { documentId: value.documentId, fileName: value.fileName, format: value.format, summaryRevision: value.summaryRevision } : null;
}
