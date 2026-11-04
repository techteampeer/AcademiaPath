'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSession } from '@/components/session/SessionProvider';
import { useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Activity, DocumentDetail, DocumentSummary } from '@/lib/api/types';
import { formatBytes, FORMAT_LABELS, segmentNoun, STRATEGY_LABELS } from './documentDisplay';

type PanelState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; detail: DocumentDetail };

/**
 * Document view: file details and download, the mock AI summary with its evidence, and the extracted
 * text. Staff see the working copy (and how it differs from what students see); students see only the
 * approved version. All document text is rendered as plain text (React escapes it), never as HTML.
 */
export function DocumentPanel({ courseId, activity, canRefresh, onChanged }: { courseId: string; activity: Activity; canRefresh: boolean; onChanged: () => void }) {
  const { handleUnauthorized } = useSession();
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

  const refresh = async () => {
    const detail = await run(
      (csrf) => api.refreshDocumentSummary(courseId, activity.id, csrf),
      (value) =>
        value.liveSummary
          ? `Summary revision ${value.summary?.revision} created. Students keep seeing approved revision ${value.liveSummary.revision} until this revision is approved.`
          : `Summary revision ${value.summary?.revision} created.`,
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
          Loading document…
        </p>
      </Card>
    );
  }
  if (state.status === 'error') {
    return (
      <Alert tone="error">
        The document could not be loaded.{' '}
        <button type="button" className="font-medium underline" onClick={() => void load()}>
          Try again
        </button>
      </Alert>
    );
  }

  const { document, summary, liveSummary } = state.detail;
  const staff = activity.review !== null;
  const showLive = staff && liveSummary !== null && liveSummary.id !== summary?.id;
  return (
    <div className="space-y-6">
      <Card as="section" aria-labelledby="document-file-heading" className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="document-file-heading" className="text-lg font-semibold text-slate-900">
              Document
            </h2>
            <p className="mt-1 text-sm break-all text-slate-600">
              {document.fileName} · {FORMAT_LABELS[document.format]} · {formatBytes(document.byteSize)}
            </p>
          </div>
          <a href={api.documentFileHref(courseId, activity.id)} download className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
            Download original
            <span className="sr-only"> ({document.fileName})</span>
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {document.extraction.status === 'extracted' ? (
            <Badge tone="success">
              Text extracted · {document.extraction.segmentCount} {segmentNoun(document.format, document.extraction.segmentCount)}
            </Badge>
          ) : (
            <Badge tone="warning">No selectable text</Badge>
          )}
          {document.extraction.truncated ? <Badge tone="warning">Text truncated at the processing limit</Badge> : null}
          {staff && document.malwareScan.status === 'not_scanned' ? <Badge>Not malware-scanned (no scanner connected)</Badge> : null}
        </div>
        {document.extraction.detail ? <p className="text-sm text-slate-600">{document.extraction.detail}</p> : null}
      </Card>

      <Card as="section" aria-labelledby="summary-heading" className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="summary-heading" className="text-lg font-semibold text-slate-900">
              Summary
            </h2>
            <p className="mt-1">
              <Badge tone="brand">{summary?.provider.label ?? 'Mock AI summary — local demonstration'}</Badge>
            </p>
          </div>
          {canRefresh ? (
            <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={pending}>
              {pending ? 'Refreshing…' : 'Refresh summary'}
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-slate-600">
          Simulated, extractive summary: each point is a sentence quoted from the document, with where it comes from. No AI model or external
          service is used, and nothing is added that is not in the document.
        </p>
        {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
        {showLive ? (
          <Alert tone="info">
            Students currently see approved summary revision {liveSummary.revision}. Revision {summary?.revision} is not visible to them until it
            is approved.
          </Alert>
        ) : null}
        {summary ? <SummaryView summary={summary} headingId="summary-points" /> : <p className="text-sm text-slate-600">No summary available.</p>}
        {showLive ? (
          <details className="rounded-lg border border-slate-200 p-3">
            <summary className="cursor-pointer text-sm font-medium text-slate-800">Show the approved revision students see</summary>
            <div className="mt-3">
              <SummaryView summary={liveSummary} headingId="live-summary-points" />
            </div>
          </details>
        ) : null}
      </Card>

      <Card as="section" aria-labelledby="extracted-heading" className="space-y-3">
        <h2 id="extracted-heading" className="text-lg font-semibold text-slate-900">
          Extracted text
        </h2>
        {document.segments.length ? (
          <div tabIndex={0} aria-labelledby="extracted-heading" className="max-h-[32rem] space-y-4 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-4">
            {document.segments.map((segment) => (
              <div key={segment.index}>
                <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{segment.label}</p>
                <p className="mt-1 text-sm break-words whitespace-pre-wrap text-slate-800">{segment.text}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-600">No text could be extracted from this file. OCR for scanned pages is not available.</p>
        )}
      </Card>
    </div>
  );
}

function SummaryView({ summary, headingId }: { summary: DocumentSummary; headingId: string }) {
  return (
    <div className="space-y-3">
      <p id={headingId} className="text-xs text-slate-500">
        Revision {summary.revision} · {STRATEGY_LABELS[summary.strategy]} · generated {new Date(summary.createdAt).toLocaleString('en-US')}
      </p>
      {summary.status === 'insufficient_text' ? (
        <p className="text-sm text-slate-700">There is not enough readable text in this document to summarize.</p>
      ) : (
        <ol className="list-decimal space-y-3 pl-5" aria-labelledby={headingId}>
          {summary.points.map((point, index) => (
            <li key={index} className="text-slate-800">
              <p className="break-words">{point.text}</p>
              <details className="mt-1 text-sm">
                <summary className="cursor-pointer text-brand-700">Evidence · {point.evidence.label}</summary>
                <blockquote className="mt-1 border-l-2 border-slate-300 pl-3 break-words text-slate-600">{point.evidence.quote}</blockquote>
              </details>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
