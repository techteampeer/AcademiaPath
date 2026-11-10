'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SelectField, TextField } from '@/components/ui/Field';
import { api } from '@/lib/api/endpoints';
import type { Activity, ActivityCreate, ActivityProgress, ResourceFolder } from '@/lib/api/types';
import { CompletionControl } from '@/components/progress/ProgressDisplay';
import { ActivityForm } from './ActivityForm';
import { ReviewStatusBadge, type ContentAbilities } from './contentDisplay';

export const lessonHref = (courseId: string, activityId: string) => `/courses/${courseId}/activities/${activityId}`;

/** Reading activities can be filed into folders and shown or hidden (quizzes and assignments cannot). */
const ORGANIZABLE = new Set<Activity['type']>(['page', 'link', 'file']);

/**
 * Activities of one section grouped into resource folders, plus an "Add content" form and, for course
 * editors, controls to organize them. The API enforces every rule; students only receive approved,
 * visible content and folders that contain it.
 */
export function SectionActivities({
  courseId,
  sectionId,
  sectionTitle,
  items,
  folders = [],
  abilities,
  completion,
  onChanged,
}: {
  courseId: string;
  sectionId: string;
  sectionTitle: string;
  items: Activity[];
  folders?: ResourceFolder[];
  abilities: ContentAbilities;
  /** The student's completion state per activity (students only; calculated by the API). */
  completion?: Record<string, ActivityProgress>;
  onChanged: () => Promise<void>;
}) {
  const { t } = useLocale();
  const r = t.resources;
  const [adding, setAdding] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderTitle, setFolderTitle] = useState('');
  const [folderError, setFolderError] = useState<string | undefined>();
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const { run, pending, result } = useCsrfAction();
  const editor = abilities.edit;

  const folderIds = new Set(folders.map((folder) => folder.id));
  const ungrouped = items.filter((activity) => !activity.folderId || !folderIds.has(activity.folderId));
  const inFolder = (folderId: string) => items.filter((activity) => activity.folderId === folderId);

  const after = async <T,>(value: T | null) => {
    if (value !== null) await onChanged();
    return value !== null;
  };

  const create = async (value: ActivityCreate) => {
    const created = await run(
      (csrf) => api.createActivity(courseId, sectionId, value, csrf),
      (activity) => t.content.section.savedDraft(activity.title),
    );
    if (created) setAdding(false);
    return after(created);
  };

  /** Swaps an activity with its neighbour inside the same group; the API stores the whole section order. */
  const moveActivity = async (group: Activity[], index: number, offset: -1 | 1) => {
    const neighbour = group[index + offset];
    const current = group[index];
    if (!neighbour || !current) return;
    const order = items.map((activity) => activity.id);
    const a = order.indexOf(current.id);
    const b = order.indexOf(neighbour.id);
    [order[a], order[b]] = [order[b]!, order[a]!];
    await after(await run((csrf) => api.orderActivities(courseId, sectionId, order, csrf), () => r.orderSaved));
  };

  const moveFolder = async (index: number, offset: -1 | 1) => {
    const order = folders.map((folder) => folder.id);
    const other = index + offset;
    if (other < 0 || other >= order.length) return;
    [order[index], order[other]] = [order[other]!, order[index]!];
    await after(await run((csrf) => api.orderResourceFolders(courseId, sectionId, order, csrf), () => r.orderSaved));
  };

  const createFolder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!folderTitle.trim()) return setFolderError(r.enterFolderTitle);
    setFolderError(undefined);
    const created = await run((csrf) => api.createResourceFolder(courseId, sectionId, folderTitle.trim(), csrf), (folder) => r.folderCreated(folder.title));
    if (created) {
      setFolderTitle('');
      setCreatingFolder(false);
    }
    await after(created);
  };

  const renameFolder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renaming || !renaming.title.trim()) return;
    const renamed = await run((csrf) => api.renameResourceFolder(courseId, renaming.id, renaming.title.trim(), csrf), (folder) => r.folderRenamed(folder.title));
    if (renamed) setRenaming(null);
    await after(renamed);
  };

  const deleteFolder = async (folder: ResourceFolder) => {
    await after(
      await run(
        async (csrf) => {
          await api.deleteResourceFolder(courseId, folder.id, csrf);
          return true;
        },
        () => r.folderDeleted(folder.title),
      ),
    );
  };

  const organize = async (activity: Activity, body: { folderId?: string | null; isVisible?: boolean }) => {
    await after(
      await run(
        (csrf) => api.organizeActivity(courseId, activity.id, body, csrf),
        (value) => (body.isVisible === undefined ? r.moved(activity.title) : value.isVisible ? r.nowVisible(activity.title) : r.nowHidden(activity.title)),
      ),
    );
  };

  const renderItems = (group: Activity[], label: string) => (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white" aria-label={label}>
      {group.map((activity, index) => {
        const state = completion?.[activity.id];
        const kind = activity.type === 'link' && 'url' in activity.content ? (activity.content.kind ?? 'website') : null;
        return (
          <li key={activity.id} className="space-y-2 px-4 py-3" data-completed={state ? String(state.completed) : undefined} data-activity={activity.title}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <Link href={lessonHref(courseId, activity.id)} className="font-medium text-brand-700 hover:underline">
                  {activity.title}
                </Link>
                <span className="ml-2 text-xs text-slate-500">{t.activityType[activity.type]}</span>
                {kind && kind !== 'website' ? (
                  <Badge tone="brand" className="ml-2">
                    {r.kindBadge[kind]}
                  </Badge>
                ) : null}
                {editor && !activity.isVisible ? (
                  <Badge tone="warning" className="ml-2">
                    {r.hiddenBadge}
                  </Badge>
                ) : null}
              </div>
              {activity.review ? (
                <div className="flex items-center gap-2">
                  {activity.liveVersion && activity.review.status !== 'approved' ? <Badge tone="success">{t.content.section.livePublished}</Badge> : null}
                  <ReviewStatusBadge status={activity.review.status} />
                </div>
              ) : null}
              {state ? (
                <CompletionControl
                  courseId={courseId}
                  activityId={activity.id}
                  title={activity.title}
                  completion={state.completion}
                  completed={state.completed}
                  onChanged={onChanged}
                />
              ) : null}
            </div>
            {editor ? (
              <div className="flex flex-wrap items-end gap-2" role="group" aria-label={`${r.organize}: ${activity.title}`}>
                <Button size="sm" variant="ghost" disabled={pending || index === 0} onClick={() => void moveActivity(group, index, -1)}>
                  ↑ {r.moveUp}
                  <span className="sr-only">: {activity.title}</span>
                </Button>
                <Button size="sm" variant="ghost" disabled={pending || index === group.length - 1} onClick={() => void moveActivity(group, index, 1)}>
                  ↓ {r.moveDown}
                  <span className="sr-only">: {activity.title}</span>
                </Button>
                {ORGANIZABLE.has(activity.type) ? (
                  <>
                    {folders.length ? (
                      <SelectField
                        id={`move-${activity.id}`}
                        className="min-w-0 sm:w-56"
                        label={r.moveTo}
                        aria-label={`${r.moveTo}: ${activity.title}`}
                        value={activity.folderId ?? ''}
                        disabled={pending}
                        onChange={(event) => void organize(activity, { folderId: event.target.value || null })}
                        options={[{ value: '', label: r.noFolder }, ...folders.map((folder) => ({ value: folder.id, label: folder.title }))]}
                      />
                    ) : null}
                    <Button size="sm" variant="secondary" disabled={pending} onClick={() => void organize(activity, { isVisible: !activity.isVisible })}>
                      {activity.isVisible ? r.hide : r.show}
                      <span className="sr-only">: {activity.title}</span>
                    </Button>
                  </>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );

  const empty = items.length === 0 && folders.length === 0;
  return (
    <div className="mt-3 space-y-3">
      {empty ? <p className="text-sm text-slate-500">{t.content.section.empty}</p> : null}
      {ungrouped.length ? renderItems(ungrouped, t.content.section.contentIn(sectionTitle)) : null}

      {folders.map((folder, index) => {
        const contents = inFolder(folder.id);
        const headingId = `folder-${folder.id}`;
        return (
          <section key={folder.id} aria-labelledby={headingId} className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3" data-folder={folder.title}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 id={headingId} className="font-semibold text-slate-900">
                <span aria-hidden="true">📁 </span>
                {folder.title}
              </h4>
              {editor && renaming?.id !== folder.id ? (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" disabled={pending || index === 0} onClick={() => void moveFolder(index, -1)}>
                    ↑ {r.moveUp}
                    <span className="sr-only">: {folder.title}</span>
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pending || index === folders.length - 1} onClick={() => void moveFolder(index, 1)}>
                    ↓ {r.moveDown}
                    <span className="sr-only">: {folder.title}</span>
                  </Button>
                  <Button size="sm" variant="secondary" disabled={pending} onClick={() => setRenaming({ id: folder.id, title: folder.title })}>
                    {r.rename}
                    <span className="sr-only">: {folder.title}</span>
                  </Button>
                  <Button size="sm" variant="secondary" disabled={pending || contents.length > 0} title={contents.length ? r.deleteHint : undefined} onClick={() => void deleteFolder(folder)}>
                    {r.deleteFolder}
                    <span className="sr-only">: {folder.title}</span>
                  </Button>
                </div>
              ) : null}
            </div>
            {renaming?.id === folder.id ? (
              <form noValidate onSubmit={renameFolder} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <TextField
                  id={`rename-${folder.id}`}
                  className="min-w-0 flex-1"
                  label={r.folderTitle}
                  value={renaming.title}
                  maxLength={120}
                  onChange={(event) => setRenaming({ id: folder.id, title: event.target.value })}
                />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={pending}>
                    {r.saveName}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => setRenaming(null)}>
                    {r.cancel}
                  </Button>
                </div>
              </form>
            ) : null}
            {contents.length ? renderItems(contents, folder.title) : <p className="text-sm text-slate-500">{r.emptyFolder}</p>}
          </section>
        );
      })}

      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}

      {editor && creatingFolder ? (
        <form noValidate onSubmit={createFolder} aria-label={`${r.newFolder}: ${sectionTitle}`} className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:flex-row sm:items-end">
          <TextField
            id={`new-folder-${sectionId}`}
            className="min-w-0 flex-1"
            label={r.folderTitle}
            value={folderTitle}
            maxLength={120}
            error={folderError}
            onChange={(event) => setFolderTitle(event.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {r.createFolder}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setCreatingFolder(false)}>
              {r.cancel}
            </Button>
          </div>
        </form>
      ) : null}

      {editor ? (
        adding ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <h4 className="mb-3 text-sm font-semibold text-slate-900">{t.content.section.addTo(sectionTitle)}</h4>
            <ActivityForm
              idPrefix={`new-${sectionId}`}
              submitLabel={t.content.section.saveDraft}
              pending={pending}
              folders={folders}
              onSubmit={create}
              onCancel={() => setAdding(false)}
            />
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
              {t.content.section.addContent}
            </Button>
            {creatingFolder ? null : (
              <Button variant="secondary" size="sm" onClick={() => setCreatingFolder(true)}>
                {r.newFolder}
                <span className="sr-only">: {sectionTitle}</span>
              </Button>
            )}
          </div>
        )
      ) : null}
    </div>
  );
}
