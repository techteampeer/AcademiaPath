'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { SelectField, TextField } from '@/components/ui/Field';
import type { Activity, ActivityCreate } from '@/lib/api/types';
import { safeHttpUrl } from './contentDisplay';

type ActivityType = Activity['type'];
type Errors = Partial<Record<'title' | 'body' | 'url' | 'description', string>>;

const LIMITS = { title: 200, body: 20000, url: 2048, description: 1000 } as const;

/** Simple form for a plain-text lesson or an external link. No rich text: lesson text is plain text. */
export function ActivityForm({
  idPrefix,
  initial,
  fixedType,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  idPrefix: string;
  initial?: Activity;
  /** Set when editing: the type cannot change. */
  fixedType?: ActivityType;
  submitLabel: string;
  pending: boolean;
  onSubmit: (value: ActivityCreate) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const initialContent = initial?.content;
  const [type, setType] = useState<ActivityType>(fixedType ?? 'page');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initialContent && 'body' in initialContent ? initialContent.body : '');
  const [url, setUrl] = useState(initialContent && 'url' in initialContent ? initialContent.url : '');
  const [description, setDescription] = useState(
    initialContent && 'url' in initialContent ? (initialContent.description ?? '') : '',
  );
  const [errors, setErrors] = useState<Errors>({});

  const validate = (): Errors => {
    const next: Errors = {};
    if (!title.trim()) next.title = 'Enter a title.';
    else if (title.length > LIMITS.title) next.title = `Use at most ${LIMITS.title} characters.`;
    if (type === 'page') {
      if (!body.trim()) next.body = 'Enter the lesson text.';
      else if (body.length > LIMITS.body) next.body = `Use at most ${LIMITS.body} characters.`;
    } else {
      if (!url.trim()) next.url = 'Enter the resource URL.';
      else if (url.length > LIMITS.url || !safeHttpUrl(url.trim())) next.url = 'Enter a full http:// or https:// URL.';
      if (description.length > LIMITS.description) next.description = `Use at most ${LIMITS.description} characters.`;
    }
    return next;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length) return;
    const value: ActivityCreate =
      type === 'page'
        ? { type: 'page', title: title.trim(), body }
        : { type: 'link', title: title.trim(), url: url.trim(), ...(description.trim() ? { description: description.trim() } : {}) };
    const saved = await onSubmit(value);
    if (saved && !initial) {
      setTitle('');
      setBody('');
      setUrl('');
      setDescription('');
    }
  };

  return (
    <form noValidate onSubmit={handleSubmit} className="space-y-4">
      {fixedType ? null : (
        <SelectField
          id={`${idPrefix}-type`}
          label="Content type"
          value={type}
          onChange={(event) => setType(event.target.value === 'link' ? 'link' : 'page')}
          options={[
            { value: 'page', label: 'Text lesson' },
            { value: 'link', label: 'External resource (link)' },
          ]}
        />
      )}
      <TextField id={`${idPrefix}-title`} label="Title" value={title} onChange={(e) => setTitle(e.target.value)} error={errors.title} maxLength={LIMITS.title} required />
      {type === 'page' ? (
        <div>
          <label htmlFor={`${idPrefix}-body`} className="block text-sm font-medium text-slate-800">
            Lesson text
          </label>
          <textarea
            id={`${idPrefix}-body`}
            rows={8}
            value={body}
            maxLength={LIMITS.body}
            onChange={(e) => setBody(e.target.value)}
            aria-invalid={errors.body ? true : undefined}
            aria-describedby={`${idPrefix}-body-hint${errors.body ? ` ${idPrefix}-body-error` : ''}`}
            className={`mt-1 block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ${errors.body ? 'border-red-500' : 'border-slate-300'}`}
          />
          <p id={`${idPrefix}-body-hint`} className="mt-1 text-xs text-slate-500">
            Plain text. Line breaks are kept; HTML is shown as text.
          </p>
          {errors.body ? (
            <p id={`${idPrefix}-body-error`} className="mt-1 text-sm text-red-700">
              {errors.body}
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <TextField id={`${idPrefix}-url`} label="URL" type="url" value={url} onChange={(e) => setUrl(e.target.value)} error={errors.url} hint="Must start with http:// or https://" required />
          <TextField id={`${idPrefix}-description`} label="Short description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} error={errors.description} maxLength={LIMITS.description} />
        </>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
