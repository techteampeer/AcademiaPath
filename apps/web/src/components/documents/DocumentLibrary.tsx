'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { ReviewStatusBadge, type ContentAbilities } from '@/components/content/contentDisplay';
import { lessonHref } from '@/components/content/SectionActivities';
import { useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SelectField, TextField } from '@/components/ui/Field';
import { api } from '@/lib/api/endpoints';
import type { Activity, DocumentDetail, Section } from '@/lib/api/types';
import { FORMAT_LABELS, segmentNoun } from './documentDisplay';

const ACCEPTED = /\.(pdf|docx|pptx)$/i;

/**
 * Course document library: every `file` activity the API returns for this user (students only receive
 * approved documents in visible sections), plus an upload form for content editors.
 */
export function DocumentLibrary({
  courseId,
  sections,
  activities,
  abilities,
  onUploaded,
}: {
  courseId: string;
  sections: Section[];
  activities: Record<string, Activity[]>;
  abilities: ContentAbilities;
  onUploaded: () => Promise<void>;
}) {
  const documents = sections.flatMap((section) =>
    (activities[section.id] ?? []).filter((activity) => activity.type === 'file').map((activity) => ({ activity, section })),
  );

  return (
    <Card as="section" aria-labelledby="documents-heading" className="space-y-4">
      <div>
        <h2 id="documents-heading" className="text-lg font-semibold text-slate-900">
          Document library
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          {abilities.viewUnapproved
            ? 'PDF, Word and PowerPoint documents with extracted text and a mock AI summary. Students see a document only after it is approved.'
            : 'Approved course documents with their extracted text and summary.'}
        </p>
      </div>
      {documents.length ? (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200" aria-label="Documents">
          {documents.map(({ activity, section }) => {
            const content = 'documentId' in activity.content ? activity.content : null;
            return (
              <li key={activity.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <div className="min-w-0">
                  <Link href={lessonHref(courseId, activity.id)} className="font-medium break-words text-brand-700 hover:underline">
                    {activity.title}
                  </Link>
                  <p className="text-xs break-all text-slate-500">
                    {content ? `${FORMAT_LABELS[content.format]} · ${content.fileName} · ` : ''}
                    {section.title}
                  </p>
                </div>
                {activity.review ? (
                  <div className="flex items-center gap-2">
                    {activity.liveVersion && activity.review.status !== 'approved' ? <Badge tone="success">Live version published</Badge> : null}
                    <ReviewStatusBadge status={activity.review.status} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-slate-500">No documents yet.</p>
      )}
      {abilities.edit && sections.length ? <UploadForm courseId={courseId} sections={sections} onUploaded={onUploaded} /> : null}
    </Card>
  );
}

function UploadForm({ courseId, sections, onUploaded }: { courseId: string; sections: Section[]; onUploaded: () => Promise<void> }) {
  const [sectionId, setSectionId] = useState(sections[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | undefined>();
  const [uploaded, setUploaded] = useState<{ detail: DocumentDetail; title: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { run, pending, result, clearResult } = useCsrfAction();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setUploaded(null);
    clearResult();
    if (!file) return setFileError('Choose a PDF, DOCX or PPTX file.');
    // Convenience only: the API verifies the file's real content and enforces the size limit.
    if (!ACCEPTED.test(file.name)) return setFileError('Only .pdf, .docx and .pptx files are accepted.');
    setFileError(undefined);
    const chosenTitle = title.trim() || file.name.replace(ACCEPTED, '');
    const detail = await run((csrf) => api.uploadDocument(courseId, sectionId, file, title, csrf));
    if (detail) {
      setUploaded({ detail, title: chosenTitle });
      setTitle('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      await onUploaded();
    }
  };

  return (
    <form noValidate onSubmit={submit} aria-labelledby="upload-heading" className="space-y-4 border-t border-slate-200 pt-4">
      <h3 id="upload-heading" className="font-semibold text-slate-900">
        Upload a document
      </h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id="document-section"
          label="Section"
          value={sectionId}
          onChange={(event) => setSectionId(event.target.value)}
          options={sections.map((section) => ({ value: section.id, label: section.isVisible ? section.title : `${section.title} (hidden from students)` }))}
        />
        <TextField
          id="document-title"
          label="Title (optional)"
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          hint="Defaults to the file name."
        />
      </div>
      <div>
        <label htmlFor="document-file" className="block text-sm font-medium text-slate-800">
          File
        </label>
        <input
          ref={fileInput}
          id="document-file"
          type="file"
          accept=".pdf,.docx,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation"
          aria-invalid={fileError ? true : undefined}
          aria-describedby={fileError ? 'document-file-hint document-file-error' : 'document-file-hint'}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          className="mt-1 block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-800 hover:file:bg-slate-50"
        />
        <p id="document-file-hint" className="mt-1 text-xs text-slate-500">
          PDF, Word (.docx) or PowerPoint (.pptx), up to 10 MB unless configured otherwise. Encrypted and macro-enabled files are refused;
          scanned pages have no extractable text (no OCR).
        </p>
        {fileError ? (
          <p id="document-file-error" className="mt-1 text-sm text-red-700">
            {fileError}
          </p>
        ) : null}
      </div>
      <p className="text-xs text-slate-500">
        Local demonstration: files are stored privately on this server and no malware scanning service is connected. Upload only synthetic or
        trusted test documents.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Uploading…' : 'Upload and extract text'}
        </Button>
        {pending ? (
          <p role="status" className="text-sm text-slate-600">
            Uploading, validating and extracting text…
          </p>
        ) : null}
      </div>
      {result?.tone === 'error' ? <Alert tone="error">{result.message}</Alert> : null}
      {uploaded ? <UploadResult courseId={courseId} {...uploaded} /> : null}
    </form>
  );
}

function UploadResult({ courseId, detail, title }: { courseId: string; detail: DocumentDetail; title: string }) {
  const { extraction, format } = detail.document;
  const extracted = extraction.status === 'extracted';
  return (
    <Alert tone={extracted ? 'success' : 'info'}>
      <p>
        &ldquo;{title}&rdquo; was uploaded as a draft.{' '}
        {extracted
          ? `Text extracted from ${extraction.segmentCount} ${segmentNoun(format, extraction.segmentCount)}; summary revision ${detail.summary?.revision ?? 1} created.`
          : 'No selectable text was found, so no summary could be created.'}
      </p>
      <Link href={lessonHref(courseId, detail.activityId)} className="mt-1 inline-block font-medium underline">
        Open the document
      </Link>
    </Alert>
  );
}
