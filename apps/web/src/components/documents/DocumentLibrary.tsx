'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { ReviewStatusBadge, type ContentAbilities } from '@/components/content/contentDisplay';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { lessonHref } from '@/components/content/SectionActivities';
import { useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SelectField, TextField } from '@/components/ui/Field';
import { api } from '@/lib/api/endpoints';
import type { Activity, DocumentDetail, Section } from '@/lib/api/types';
import { segmentCount } from './documentDisplay';

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
  const { t } = useLocale();
  const l = t.documents.library;
  const documents = sections.flatMap((section) =>
    (activities[section.id] ?? []).filter((activity) => activity.type === 'file').map((activity) => ({ activity, section })),
  );

  return (
    <Card as="section" aria-labelledby="documents-heading" className="space-y-4">
      <div>
        <h2 id="documents-heading" className="text-lg font-semibold text-brand-600">
          {l.heading}
        </h2>
        <p className="mt-1 text-sm text-slate-600">{abilities.viewUnapproved ? l.staffIntro : l.studentIntro}</p>
      </div>
      {documents.length ? (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200" aria-label={l.listLabel}>
          {documents.map(({ activity, section }) => {
            const content = 'documentId' in activity.content ? activity.content : null;
            return (
              <li key={activity.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <div className="min-w-0">
                  <Link href={lessonHref(courseId, activity.id)} className="font-medium break-words text-brand-700 hover:underline">
                    {activity.title}
                  </Link>
                  <p className="text-xs break-all text-slate-500">
                    {content ? `${t.documents.formats[content.format]} · ${content.fileName} · ` : ''}
                    {section.title}
                  </p>
                </div>
                {activity.review ? (
                  <div className="flex items-center gap-2">
                    {activity.liveVersion && activity.review.status !== 'approved' ? <Badge tone="success">{t.content.section.livePublished}</Badge> : null}
                    <ReviewStatusBadge status={activity.review.status} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-slate-500">{l.empty}</p>
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
  const { t } = useLocale();
  const l = t.documents.library;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setUploaded(null);
    clearResult();
    if (!file) return setFileError(l.chooseFile);
    // Convenience only: the API verifies the file's real content and enforces the size limit.
    if (!ACCEPTED.test(file.name)) return setFileError(l.onlyAccepted);
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
        {l.uploadHeading}
      </h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id="document-section"
          label={l.section}
          value={sectionId}
          onChange={(event) => setSectionId(event.target.value)}
          options={sections.map((section) => ({ value: section.id, label: section.isVisible ? section.title : l.hiddenSection(section.title) }))}
        />
        <TextField
          id="document-title"
          label={l.title}
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          hint={l.titleHint}
        />
      </div>
      <div>
        <label htmlFor="document-file" className="block text-sm font-medium text-slate-800">
          {l.file}
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
          {l.fileHint}
        </p>
        {fileError ? (
          <p id="document-file-error" className="mt-1 text-sm text-red-700">
            {fileError}
          </p>
        ) : null}
      </div>
      <p className="text-xs text-slate-500">
        {l.notice}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? l.uploading : l.upload}
        </Button>
        {pending ? (
          <p role="status" className="text-sm text-slate-600">
            {l.progress}
          </p>
        ) : null}
      </div>
      {result?.tone === 'error' ? <Alert tone="error">{result.message}</Alert> : null}
      {uploaded ? <UploadResult courseId={courseId} {...uploaded} /> : null}
    </form>
  );
}

function UploadResult({ courseId, detail, title }: { courseId: string; detail: DocumentDetail; title: string }) {
  const { t } = useLocale();
  const l = t.documents.library;
  const { extraction, format } = detail.document;
  const extracted = extraction.status === 'extracted';
  return (
    <Alert tone={extracted ? 'success' : 'info'}>
      <p>
        {l.uploadedDraft(title)} {extracted ? l.extracted(segmentCount(t, format, extraction.segmentCount), detail.summary?.revision ?? 1) : l.noText}
      </p>
      <Link href={lessonHref(courseId, detail.activityId)} className="mt-1 inline-block font-medium underline">
        {l.openDocument}
      </Link>
    </Alert>
  );
}
