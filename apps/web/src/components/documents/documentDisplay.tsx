import type { DocumentFormat, DocumentSummary } from '@/lib/api/types';

export const FORMAT_LABELS: Record<DocumentFormat, string> = { pdf: 'PDF', docx: 'Word (.docx)', pptx: 'PowerPoint (.pptx)' };

const SEGMENT_NOUNS: Record<DocumentFormat, [string, string]> = {
  pdf: ['page', 'pages'],
  docx: ['paragraph', 'paragraphs'],
  pptx: ['slide', 'slides'],
};

export const segmentNoun = (format: DocumentFormat, count: number) => SEGMENT_NOUNS[format][count === 1 ? 0 : 1];

export const STRATEGY_LABELS: Record<DocumentSummary['strategy'], string> = {
  key_sentences: 'Key sentences',
  section_coverage: 'Section coverage',
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
