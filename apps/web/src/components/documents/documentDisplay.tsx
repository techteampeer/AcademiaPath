import type { DocumentFormat, DocumentSegment } from '@/lib/api/types';
import type { Messages } from '@/lib/i18n/messages';

/** "3 pages", "1 slide", "7 paragraphs" in the interface language. */
export function segmentCount(t: Messages, format: DocumentFormat, count: number): string {
  const kind = format === 'pdf' ? 'page' : format === 'pptx' ? 'slide' : 'paragraph';
  return t.documents.segments[kind](count);
}

/**
 * The server labels each block "Page 3", "Slide 2" or "Paragraph 5" (English). The label is rebuilt
 * from the block's kind and number in the interface language; unknown labels are shown unchanged.
 */
export function segmentLabel(t: Messages, kind: DocumentSegment['kind'], label: string): string {
  const number = /(\d+)$/.exec(label)?.[1];
  return number ? t.documents.segmentLabel[kind](number) : label;
}

export function formatBytes(bytes: number, locale: 'en' | 'es'): string {
  const format = (value: number) => value.toLocaleString(locale === 'es' ? 'es-PE' : 'en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${format(bytes / 1024)} KB`;
  return `${format(bytes / (1024 * 1024))} MB`;
}
