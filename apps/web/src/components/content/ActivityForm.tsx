'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { SelectField, TextField } from '@/components/ui/Field';
import { fromLocalInput, toLocalInput } from '@/components/assignments/assignmentDisplay';
import { emptyCriterion, RubricEditor, validateRubric, type CriterionDraft } from '@/components/assignments/RubricEditor';
import type { Activity, ActivityCreate } from '@/lib/api/types';
import { safeHttpUrl } from './contentDisplay';

type ActivityType = Activity['type'];
type Errors = Partial<
  Record<'title' | 'body' | 'url' | 'description' | 'instructions' | 'attemptLimit' | 'timeLimitMinutes' | 'dueAt' | 'lateUntil' | 'rubric', string>
>;

const LIMITS = {
  title: 200,
  body: 20000,
  url: 2048,
  description: 1000,
  instructions: 5000,
  assignmentInstructions: 20000,
  attemptLimit: 10,
  timeLimitMinutes: 300,
  lateWindowDays: 30,
} as const;

function wholeNumberIn(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/**
 * Simple form for a plain-text lesson, an external link or a quiz's settings. No rich text: lesson
 * text is plain text. Quiz questions are managed separately once the quiz exists.
 */
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
  const quiz = initialContent && 'attemptLimit' in initialContent ? initialContent : null;
  const assignment = initialContent && 'rubric' in initialContent ? initialContent : null;
  const [instructions, setInstructions] = useState(quiz?.instructions ?? assignment?.instructions ?? '');
  const [dueAt, setDueAt] = useState(toLocalInput(assignment?.dueAt ?? null));
  const [lateUntil, setLateUntil] = useState(toLocalInput(assignment?.lateUntil ?? null));
  const [criteria, setCriteria] = useState<CriterionDraft[]>(
    assignment?.rubric.map((c) => ({ title: c.title, maxPoints: String(c.maxPoints), description: c.description ?? '' })) ?? [emptyCriterion()],
  );
  const [attemptLimit, setAttemptLimit] = useState(String(quiz?.attemptLimit ?? 1));
  const [timeLimit, setTimeLimit] = useState(quiz?.timeLimitMinutes ? String(quiz.timeLimitMinutes) : '');
  const [shuffleQuestions, setShuffleQuestions] = useState(quiz?.shuffleQuestions ?? false);
  const [shuffleOptions, setShuffleOptions] = useState(quiz?.shuffleOptions ?? false);
  const [errors, setErrors] = useState<Errors>({});

  const validate = (): Errors => {
    const next: Errors = {};
    if (!title.trim()) next.title = 'Enter a title.';
    else if (title.length > LIMITS.title) next.title = `Use at most ${LIMITS.title} characters.`;
    if (type === 'page') {
      if (!body.trim()) next.body = 'Enter the lesson text.';
      else if (body.length > LIMITS.body) next.body = `Use at most ${LIMITS.body} characters.`;
    } else if (type === 'assignment') {
      if (!instructions.trim()) next.instructions = 'Enter the assignment instructions.';
      else if (instructions.length > LIMITS.assignmentInstructions) next.instructions = `Use at most ${LIMITS.assignmentInstructions} characters.`;
      const due = fromLocalInput(dueAt);
      const late = fromLocalInput(lateUntil);
      if (!due) next.dueAt = 'Choose the due date and time.';
      if (lateUntil && !late) next.lateUntil = 'Choose a valid date and time, or leave empty.';
      else if (due && late && (Date.parse(late) <= Date.parse(due) || Date.parse(late) - Date.parse(due) > LIMITS.lateWindowDays * 86_400_000)) {
        next.lateUntil = `Late submissions must end after the due date and at most ${LIMITS.lateWindowDays} days later.`;
      }
      const rubricError = validateRubric(criteria);
      if (rubricError) next.rubric = rubricError;
    } else if (type === 'quiz') {
      if (instructions.length > LIMITS.instructions) next.instructions = `Use at most ${LIMITS.instructions} characters.`;
      if (wholeNumberIn(attemptLimit, 1, LIMITS.attemptLimit) === null) next.attemptLimit = `Enter a whole number from 1 to ${LIMITS.attemptLimit}.`;
      if (timeLimit.trim() && wholeNumberIn(timeLimit, 1, LIMITS.timeLimitMinutes) === null) {
        next.timeLimitMinutes = `Enter whole minutes from 1 to ${LIMITS.timeLimitMinutes}, or leave empty.`;
      }
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
        : type === 'assignment'
          ? {
              type: 'assignment',
              title: title.trim(),
              instructions,
              dueAt: fromLocalInput(dueAt)!,
              lateUntil: fromLocalInput(lateUntil),
              rubric: criteria.map((c) => ({
                title: c.title.trim(),
                maxPoints: Number(c.maxPoints),
                ...(c.description.trim() ? { description: c.description.trim() } : {}),
              })),
            }
          : type === 'quiz'
          ? {
              type: 'quiz',
              title: title.trim(),
              ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
              attemptLimit: Number(attemptLimit),
              timeLimitMinutes: timeLimit.trim() ? Number(timeLimit) : null,
              shuffleQuestions,
              shuffleOptions,
            }
          : { type: 'link', title: title.trim(), url: url.trim(), ...(description.trim() ? { description: description.trim() } : {}) };
    const saved = await onSubmit(value);
    if (saved && !initial) {
      setTitle('');
      setBody('');
      setUrl('');
      setDescription('');
      setInstructions('');
      setDueAt('');
      setLateUntil('');
      setCriteria([emptyCriterion()]);
      setAttemptLimit('1');
      setTimeLimit('');
      setShuffleQuestions(false);
      setShuffleOptions(false);
    }
  };

  return (
    <form noValidate onSubmit={handleSubmit} className="space-y-4">
      {fixedType ? null : (
        <SelectField
          id={`${idPrefix}-type`}
          label="Content type"
          value={type}
          onChange={(event) => {
            const next = event.target.value;
            setType(next === 'link' || next === 'quiz' || next === 'assignment' ? next : 'page');
          }}
          options={[
            { value: 'page', label: 'Text lesson' },
            { value: 'link', label: 'External resource (link)' },
            { value: 'quiz', label: 'Quiz' },
            { value: 'assignment', label: 'Assignment (text submission)' },
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
      ) : type === 'assignment' ? (
        <>
          <div>
            <label htmlFor={`${idPrefix}-assignment-instructions`} className="block text-sm font-medium text-slate-800">
              Instructions
            </label>
            <textarea
              id={`${idPrefix}-assignment-instructions`}
              rows={5}
              value={instructions}
              maxLength={LIMITS.assignmentInstructions}
              onChange={(e) => setInstructions(e.target.value)}
              aria-invalid={errors.instructions ? true : undefined}
              aria-describedby={errors.instructions ? `${idPrefix}-assignment-instructions-error` : undefined}
              className={`mt-1 block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ${errors.instructions ? 'border-red-500' : 'border-slate-300'}`}
            />
            {errors.instructions ? (
              <p id={`${idPrefix}-assignment-instructions-error`} className="mt-1 text-sm text-red-700">
                {errors.instructions}
              </p>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              id={`${idPrefix}-due`}
              label="Due date and time"
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              error={errors.dueAt}
              hint="Your local time. The server decides whether a submission is on time."
              required
            />
            <TextField
              id={`${idPrefix}-late`}
              label="Accept late submissions until (optional)"
              type="datetime-local"
              value={lateUntil}
              onChange={(e) => setLateUntil(e.target.value)}
              error={errors.lateUntil}
              hint="Late work is accepted until then and marked late. Leave empty to close at the due date."
            />
          </div>
          <RubricEditor idPrefix={idPrefix} criteria={criteria} onChange={setCriteria} error={errors.rubric} />
        </>
      ) : type === 'quiz' ? (
        <>
          <div>
            <label htmlFor={`${idPrefix}-instructions`} className="block text-sm font-medium text-slate-800">
              Instructions (optional)
            </label>
            <textarea
              id={`${idPrefix}-instructions`}
              rows={3}
              value={instructions}
              maxLength={LIMITS.instructions}
              onChange={(e) => setInstructions(e.target.value)}
              aria-invalid={errors.instructions ? true : undefined}
              aria-describedby={errors.instructions ? `${idPrefix}-instructions-error` : undefined}
              className={`mt-1 block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ${errors.instructions ? 'border-red-500' : 'border-slate-300'}`}
            />
            {errors.instructions ? (
              <p id={`${idPrefix}-instructions-error`} className="mt-1 text-sm text-red-700">
                {errors.instructions}
              </p>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField id={`${idPrefix}-attempts`} label="Attempts allowed" inputMode="numeric" value={attemptLimit} onChange={(e) => setAttemptLimit(e.target.value)} error={errors.attemptLimit} required />
            <TextField
              id={`${idPrefix}-time-limit`}
              label="Time limit in minutes (optional)"
              inputMode="numeric"
              value={timeLimit}
              onChange={(e) => setTimeLimit(e.target.value)}
              error={errors.timeLimitMinutes}
              hint="Enforced by the server. Leave empty for no limit."
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-800">Order</legend>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={shuffleQuestions} onChange={(e) => setShuffleQuestions(e.target.checked)} />
              Shuffle question order for each attempt
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={shuffleOptions} onChange={(e) => setShuffleOptions(e.target.checked)} />
              Shuffle answer options for each attempt
            </label>
          </fieldset>
          {initial ? null : <p className="text-xs text-slate-500">Add questions after creating the quiz.</p>}
        </>
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
