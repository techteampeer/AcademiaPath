'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useSession } from '@/components/session/SessionProvider';
import { useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Activity, DocumentDetail, DocumentSummary } from '@/lib/api/types';
import { formatDateTimeOrDash, type Messages } from '@/lib/i18n/messages';
import { formatBytes, segmentCount, segmentLabel } from './documentDisplay';

type PanelState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; detail: DocumentDetail };

/**
 * Extraction note in the interface language. The API's note is English, so in Spanish it is chosen
 * from the extraction status and format instead (the document's own text is never translated).
 */
function extractionNote(t: Messages, locale: 'en' | 'es', document: DocumentDetail['document']): string | null {
  const { detail, status } = document.extraction;
  if (locale === 'en' || detail === null) return detail;
  if (status === 'no_text') return t.documents.panel.noTextDetail[document.format];
  if (/pages contain selectable text/.test(detail)) return t.documents.panel.partialPdf;
  if (document.format === 'pptx') return t.documents.panel.slidesOnly;
  return detail;
}

/**
 * Document view: file details and download, the mock AI summary with its evidence, and the extracted
 * text. Staff see the working copy (and how it differs from what students see); students see only the
 * approved version. All document text is rendered as plain text (React escapes it), never as HTML.
 */
export function DocumentPanel({ courseId, activity, canRefresh, onChanged }: { courseId: string; activity: Activity; canRefresh: boolean; onChanged: () => void }) {
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const p = t.documents.panel;
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  const { run, pending, result } = useCsrfAction();

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', detail: await api.getDocument(courseId, activity.id) });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setState({ status: 'error' });
    }
  }, [courseId, activity.id, handleUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  // A study-brief location (#segment-N) opens the extracted text at that page, slide or paragraph once it is loaded.
  useEffect(() => {
    if (state.status !== 'ready') return;
    const target = /^#segment-(\d+)$/.exec(window.location.hash) ? window.document.getElementById(window.location.hash.slice(1)) : null;
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.focus({ preventScroll: true });
    }
  }, [state.status]);

  const refresh = async () => {
    const detail = await run(
      (csrf) => api.refreshDocumentSummary(courseId, activity.id, csrf),
      (value) =>
        value.liveSummary ? p.refreshedLive(value.summary?.revision ?? 0, value.liveSummary.revision) : p.refreshed(value.summary?.revision ?? 0),
    );
    if (detail) {
      setState({ status: 'ready', detail });
      onChanged();
    }
  };

  if (state.status === 'loading') {
    return (
      <Card>
        <p role="status" className="text-sm text-slate-600">
          {p.loading}
        </p>
      </Card>
    );
  }
  if (state.status === 'error') {
    return (
      <Alert tone="error">
        {p.loadError}{' '}
        <button type="button" className="font-medium underline" onClick={() => void load()}>
          {t.common.retry}
        </button>
      </Alert>
    );
  }

  const { document, summary, liveSummary } = state.detail;
  const staff = activity.review !== null;
  const showLive = staff && liveSummary !== null && liveSummary.id !== summary?.id;
  const note = extractionNote(t, locale, document);
  return (
    <div className="space-y-6">
      <Card as="section" aria-labelledby="document-file-heading" className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="document-file-heading" className="text-lg font-semibold text-brand-600">
              {p.heading}
            </h2>
            <p className="mt-1 text-sm break-all text-slate-600">
              {document.fileName} · {t.documents.formats[document.format]} · {formatBytes(document.byteSize, locale)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={`/courses/${courseId}/activities/${activity.id}/brief`} className={buttonClasses({ size: 'sm' })} aria-describedby="study-brief-hint">
              {t.documents.brief.create}
            </Link>
            <a href={api.documentFileHref(courseId, activity.id)} download className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
              {p.download}
              <span className="sr-only"> ({document.fileName})</span>
            </a>
          </div>
        </div>
        <p id="study-brief-hint" className="text-xs text-slate-500">
          {t.documents.brief.createHint}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {document.extraction.status === 'extracted' ? (
            <Badge tone="success">{p.textExtracted(segmentCount(t, document.format, document.extraction.segmentCount))}</Badge>
          ) : (
            <Badge tone="warning">{p.noSelectableText}</Badge>
          )}
          {document.extraction.truncated ? <Badge tone="warning">{p.truncated}</Badge> : null}
          {staff && document.malwareScan.status === 'not_scanned' ? <Badge>{p.notScanned}</Badge> : null}
        </div>
        {note ? <p className="text-sm text-slate-600">{note}</p> : null}
      </Card>

      <Card as="section" aria-labelledby="summary-heading" className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="summary-heading" className="text-lg font-semibold text-brand-600">
              {p.summary}
            </h2>
            <p className="mt-1">
              {/* Always shown: the summary is simulated (mock provider), never output of an AI model. */}
              <Badge tone="brand">{p.mockLabel}</Badge>
            </p>
          </div>
          {canRefresh ? (
            <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={pending}>
              {pending ? p.refreshing : p.refresh}
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-slate-600">{p.explanation}</p>
        {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
        {showLive ? <Alert tone="info">{p.liveNote(liveSummary.revision, summary?.revision ?? 0)}</Alert> : null}
        {summary ? <SummaryView summary={summary} document={document} headingId="summary-points" /> : <p className="text-sm text-slate-600">{p.noSummary}</p>}
        {showLive ? (
          <details className="rounded-lg border border-slate-200 p-3">
            <summary className="cursor-pointer text-sm font-medium text-slate-800">{p.showLive}</summary>
            <div className="mt-3">
              <SummaryView summary={liveSummary} document={document} headingId="live-summary-points" />
            </div>
          </details>
        ) : null}
      </Card>

      <Card as="section" aria-labelledby="extracted-heading" className="space-y-3">
        <h2 id="extracted-heading" className="text-lg font-semibold text-brand-600">
          {p.extractedText}
        </h2>
        {document.segments.length ? (
          <div tabIndex={0} aria-labelledby="extracted-heading" className="max-h-[32rem] space-y-4 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-4">
            {document.segments.map((segment) => (
              <div key={segment.index} id={`segment-${segment.index}`} tabIndex={-1} className="scroll-mt-24 rounded focus:bg-gold-100/50">
                <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{segmentLabel(t, segment.kind, segment.label)}</p>
                <p className="mt-1 text-sm break-words whitespace-pre-wrap text-slate-800">{segment.text}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-600">{p.noExtractedText}</p>
        )}
      </Card>
    </div>
  );
}

function SummaryView({ summary, document, headingId }: { summary: DocumentSummary; document: DocumentDetail['document']; headingId: string }) {
  const { t, locale } = useLocale();
  const p = t.documents.panel;
  return (
    <div className="space-y-3">
      <p id={headingId} className="text-xs text-slate-500">
        {p.revisionLine(summary.revision, p.strategies[summary.strategy], formatDateTimeOrDash(summary.createdAt, locale))}
      </p>
      {summary.status === 'insufficient_text' ? (
        <p className="text-sm text-slate-700">{p.insufficient}</p>
      ) : (
        <ol className="list-decimal space-y-3 pl-5" aria-labelledby={headingId}>
          {summary.points.map((point, index) => {
            const kind = document.segments[point.evidence.segmentIndex]?.kind;
            const label = kind ? segmentLabel(t, kind, point.evidence.label) : point.evidence.label;
            return (
              <li key={index} className="text-slate-800">
                <p className="break-words">{point.text}</p>
                <details className="mt-1 text-sm">
                  <summary className="cursor-pointer text-brand-700">{p.evidence(label)}</summary>
                  <blockquote className="mt-1 border-l-2 border-slate-300 pl-3 break-words text-slate-600">{point.evidence.quote}</blockquote>
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
