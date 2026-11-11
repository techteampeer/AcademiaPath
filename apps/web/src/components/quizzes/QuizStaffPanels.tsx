'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError, useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SelectField, TextField } from '@/components/ui/Field';
import { ReleaseGradesButton } from '@/components/grades/ReleaseGradesButton';
import { isApiError } from '@/lib/api/client';
import { api, loadAll } from '@/lib/api/endpoints';
import type { QuizAttemptResult, QuizQuestion, QuizQuestionInput, QuizQuestionType, QuizResult } from '@/lib/api/types';
import { formatDateTimeOrDash, type Messages } from '@/lib/i18n/messages';

type Load<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T };

/**
 * Question bank with answer keys. Answer keys are fetched at runtime from a staff-only endpoint;
 * nothing about them is part of the page bundle.
 */
export function QuizQuestionsPanel({
  courseId,
  quizId,
  canEdit,
  hasLiveVersion,
  onChanged,
}: {
  courseId: string;
  quizId: string;
  canEdit: boolean;
  /** True when students already see an approved version of this quiz. */
  hasLiveVersion: boolean;
  /** Called after questions change, so the quiz (review status, totals) can be reloaded. */
  onChanged: () => void;
}) {
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const qb = t.quiz.bank;
  const [state, setState] = useState<Load<QuizQuestion[]>>({ status: 'loading' });
  const { run, pending, result } = useCsrfAction();

  const load = useCallback(async () => {
    try {
      const list = await api.listQuizQuestions(courseId, quizId);
      setState({ status: 'ready', data: list.items });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setState({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [courseId, quizId, handleUnauthorized, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (input: QuizQuestionInput) => {
    const saved = await run((csrf) => api.addQuizQuestion(courseId, quizId, input, csrf), () => qb.added);
    if (saved) {
      await load();
      onChanged();
    }
    return saved !== null;
  };

  const remove = async (question: QuizQuestion, index: number) => {
    const done = await run(
      (csrf) => api.removeQuizQuestion(courseId, quizId, question.id, csrf).then(() => true),
      () => qb.removed(index + 1),
    );
    if (done) {
      await load();
      onChanged();
    }
  };

  return (
    <Card as="section" aria-labelledby="questions-heading" className="space-y-4">
      <h2 id="questions-heading" className="text-lg font-semibold text-brand-600">
        {qb.heading}
      </h2>
      <p className="text-sm text-slate-600">{qb.staffOnly}</p>
      {canEdit && hasLiveVersion ? (
        <p className="text-sm text-slate-600">
          {qb.revisionNote}
        </p>
      ) : null}
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      {state.status === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          {qb.loading}
        </p>
      ) : state.status === 'error' ? (
        <Alert tone="error">{state.message}</Alert>
      ) : state.data.length === 0 ? (
        <p className="text-sm text-slate-600">{qb.empty}</p>
      ) : (
        <ol className="space-y-3">
          {state.data.map((question, index) => (
            <li key={question.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="font-medium break-words text-slate-900">
                  {index + 1}. {question.prompt}
                </p>
                {canEdit ? (
                  <Button variant="ghost" size="sm" onClick={() => void remove(question, index)} disabled={pending}>
                    {qb.remove}
                    <span className="sr-only"> {qb.questionN(index + 1)}</span>
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-slate-500">
                {t.quiz.questionTypes[question.type]} · {t.quiz.points(question.points)}
              </p>
              <ul className="mt-2 space-y-1 text-sm">
                {question.options.map((option) => (
                  <li key={option.id} className={option.isCorrect ? 'font-medium text-emerald-800' : 'text-slate-700'}>
                    {option.isCorrect ? '✓ ' : '• '}
                    {option.text}
                    {option.isCorrect ? <span className="sr-only"> {qb.correctAnswerSr}</span> : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      {canEdit ? <QuestionForm pending={pending} onSubmit={add} /> : null}
      {canEdit ? (
        <ImportQuestions
          courseId={courseId}
          quizId={quizId}
          onImported={async () => {
            await load();
            onChanged();
          }}
        />
      ) : null}
    </Card>
  );
}

/**
 * Question reuse (AP-022): copies the approved questions of another approved quiz in this course. The API
 * checks the course, the source's approval and the editor role; the copies go through review again.
 */
function ImportQuestions({ courseId, quizId, onImported }: { courseId: string; quizId: string; onImported: () => Promise<void> }) {
  const { t } = useLocale();
  const a = t.assessment;
  const { run, pending, result } = useCsrfAction();
  const [sources, setSources] = useState<Array<{ id: string; title: string }> | null>(null);
  const [source, setSource] = useState('');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sections = await loadAll((page) => api.listSections(courseId, page), 5);
      const lists = await Promise.all(sections.map((section) => loadAll((page) => api.listActivities(courseId, section.id, page), 5)));
      // Staff see live versions: only quizzes with an approved version can be a source.
      const quizzes = lists.flat().filter((activity) => activity.type === 'quiz' && activity.id !== quizId && activity.liveVersion);
      if (!cancelled) {
        setSources(quizzes.map((quiz) => ({ id: quiz.id, title: quiz.liveVersion?.title ?? quiz.title })));
        setSource(quizzes[0]?.id ?? '');
      }
    })().catch(() => !cancelled && setSources([]));
    return () => {
      cancelled = true;
    };
  }, [courseId, quizId]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!source) return;
    const list = await run((csrf) => api.importQuizQuestions(courseId, quizId, source, csrf), (value) => a.imported(value.items.length));
    if (list) await onImported();
  };

  return (
    <form noValidate onSubmit={submit} aria-labelledby="import-questions-heading" className="space-y-3 border-t border-slate-200 pt-4">
      <h3 id="import-questions-heading" className="font-semibold text-slate-900">
        {a.importHeading}
      </h3>
      <p className="text-sm text-slate-600">{a.importHint}</p>
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      {sources === null ? null : sources.length === 0 ? (
        <p className="text-sm text-slate-500">{a.noSources}</p>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <SelectField
            id="import-source"
            className="min-w-0 flex-1"
            label={a.importSource}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            options={sources.map((quiz) => ({ value: quiz.id, label: quiz.title }))}
          />
          <Button type="submit" variant="secondary" disabled={pending || !source}>
            {a.importButton}
          </Button>
        </div>
      )}
    </form>
  );
}

type OptionDraft = { text: string; isCorrect: boolean };
type QuestionErrors = Partial<Record<'prompt' | 'points' | 'options', string>>;
const QUESTION_LIMITS = { prompt: 2000, optionText: 500, points: 100, minOptions: 2, maxOptions: 10 } as const;
const emptyOptions = (): OptionDraft[] => [
  { text: '', isCorrect: false },
  { text: '', isCorrect: false },
];

function QuestionForm({ pending, onSubmit }: { pending: boolean; onSubmit: (input: QuizQuestionInput) => Promise<boolean> }) {
  const [type, setType] = useState<QuizQuestionType>('single_choice');
  const [prompt, setPrompt] = useState('');
  const [points, setPoints] = useState('1');
  const [options, setOptions] = useState<OptionDraft[]>(emptyOptions);
  const [trueFalseAnswer, setTrueFalseAnswer] = useState<'true' | 'false'>('true');
  const [errors, setErrors] = useState<QuestionErrors>({});
  const { t } = useLocale();
  const qf = t.quiz.form;

  const updateOption = (index: number, change: Partial<OptionDraft>) =>
    setOptions((current) =>
      current.map((option, i) => {
        if (i === index) return { ...option, ...change };
        // A single-answer question has exactly one correct option.
        return change.isCorrect && type === 'single_choice' ? { ...option, isCorrect: false } : option;
      }),
    );

  const changeType = (next: QuizQuestionType) => {
    setType(next);
    if (next === 'single_choice') {
      setOptions((current) => {
        const first = current.findIndex((option) => option.isCorrect);
        return current.map((option, i) => ({ ...option, isCorrect: i === first }));
      });
    }
  };

  const validate = (): QuestionErrors => {
    const next: QuestionErrors = {};
    if (!prompt.trim()) next.prompt = qf.enterQuestion;
    else if (prompt.length > QUESTION_LIMITS.prompt) next.prompt = t.errors.maxChars(QUESTION_LIMITS.prompt);
    const value = Number(points);
    if (!/^\d+$/.test(points.trim()) || value < 1 || value > QUESTION_LIMITS.points) next.points = t.errors.wholeNumber(1, QUESTION_LIMITS.points);
    if (type !== 'true_false') {
      const correct = options.filter((option) => option.isCorrect).length;
      if (options.some((option) => !option.text.trim())) next.options = qf.optionsEmpty;
      else if (options.some((option) => option.text.length > QUESTION_LIMITS.optionText)) next.options = qf.optionsLength(QUESTION_LIMITS.optionText);
      else if (type === 'single_choice' && correct !== 1) next.options = qf.markOne;
      else if (type === 'multiple_choice' && correct < 1) next.options = qf.markSome;
    }
    return next;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length) return;
    const base = { prompt: prompt.trim(), points: Number(points) };
    const input: QuizQuestionInput =
      type === 'true_false'
        ? { type, ...base, correctAnswer: trueFalseAnswer === 'true' }
        : { type, ...base, options: options.map((option) => ({ text: option.text.trim(), isCorrect: option.isCorrect })) };
    if (await onSubmit(input)) {
      setPrompt('');
      setPoints('1');
      setOptions(emptyOptions());
      setTrueFalseAnswer('true');
    }
  };

  return (
    <form noValidate onSubmit={handleSubmit} className="space-y-4 border-t border-slate-200 pt-4" aria-labelledby="add-question-heading">
      <h3 id="add-question-heading" className="font-semibold text-slate-900">
        {qf.heading}
      </h3>
      <SelectField
        id="question-type"
        label={qf.type}
        value={type}
        onChange={(event) => changeType(event.target.value as QuizQuestionType)}
        options={[
          { value: 'single_choice', label: t.quiz.questionTypes.single_choice },
          { value: 'multiple_choice', label: t.quiz.questionTypes.multiple_choice },
          { value: 'true_false', label: t.quiz.questionTypes.true_false },
        ]}
      />
      <div>
        <label htmlFor="question-prompt" className="block text-sm font-medium text-slate-800">
          {qf.question}
        </label>
        <textarea
          id="question-prompt"
          rows={2}
          value={prompt}
          maxLength={QUESTION_LIMITS.prompt}
          onChange={(event) => setPrompt(event.target.value)}
          aria-invalid={errors.prompt ? true : undefined}
          aria-describedby={errors.prompt ? 'question-prompt-error' : undefined}
          className={`mt-1 block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ${errors.prompt ? 'border-red-500' : 'border-slate-300'}`}
        />
        {errors.prompt ? (
          <p id="question-prompt-error" className="mt-1 text-sm text-red-700">
            {errors.prompt}
          </p>
        ) : null}
      </div>
      <TextField id="question-points" label={qf.points} inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value)} error={errors.points} className="max-w-40" />
      {type === 'true_false' ? (
        <SelectField
          id="question-tf-answer"
          label={qf.correctAnswer}
          value={trueFalseAnswer}
          onChange={(event) => setTrueFalseAnswer(event.target.value === 'false' ? 'false' : 'true')}
          options={[
            { value: 'true', label: qf.trueLabel },
            { value: 'false', label: qf.falseLabel },
          ]}
          className="max-w-40"
        />
      ) : (
        <fieldset className="space-y-2" aria-describedby={errors.options ? 'question-options-error' : undefined}>
          <legend className="text-sm font-medium text-slate-800">
            {type === 'single_choice' ? qf.optionsSingle : qf.optionsMultiple}
          </legend>
          {options.map((option, index) => (
            <div key={index} className="flex flex-wrap items-center gap-3">
              <input
                id={`question-option-${index}-correct`}
                type={type === 'single_choice' ? 'radio' : 'checkbox'}
                name="question-correct"
                checked={option.isCorrect}
                onChange={(event) => updateOption(index, { isCorrect: event.target.checked })}
              />
              <label htmlFor={`question-option-${index}-correct`} className="sr-only">
                {qf.optionIsCorrect(index + 1)}
              </label>
              <label htmlFor={`question-option-${index}`} className="sr-only">
                {qf.optionText(index + 1)}
              </label>
              <input
                id={`question-option-${index}`}
                value={option.text}
                maxLength={QUESTION_LIMITS.optionText}
                placeholder={qf.optionPlaceholder(index + 1)}
                onChange={(event) => updateOption(index, { text: event.target.value })}
                className="block min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
              />
              {options.length > QUESTION_LIMITS.minOptions ? (
                <Button variant="ghost" size="sm" onClick={() => setOptions((current) => current.filter((_, i) => i !== index))}>
                  {t.quiz.bank.remove}
                  <span className="sr-only"> {qf.optionN(index + 1)}</span>
                </Button>
              ) : null}
            </div>
          ))}
          {options.length < QUESTION_LIMITS.maxOptions ? (
            <Button variant="secondary" size="sm" onClick={() => setOptions((current) => [...current, { text: '', isCorrect: false }])}>
              {qf.addOption}
            </Button>
          ) : null}
          {errors.options ? (
            <p id="question-options-error" className="text-sm text-red-700">
              {errors.options}
            </p>
          ) : null}
        </fieldset>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? qf.saving : qf.submit}
      </Button>
    </form>
  );
}

function attemptStatusLabel(result: Pick<QuizResult, 'status' | 'closedByTimeLimit'>, r: Messages['quiz']['results']) {
  if (result.status === 'in_progress') return r.statusInProgress;
  return result.closedByTimeLimit ? r.statusClosed : r.statusSubmitted;
}

/** Student attempts and server-calculated scores, for instructors and administrators. */
export function QuizResultsPanel({ courseId, quizId, canRelease = false }: { courseId: string; quizId: string; canRelease?: boolean }) {
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const r = t.quiz.results;
  const [state, setState] = useState<Load<{ items: QuizResult[]; nextCursor: string | null }>>({ status: 'loading' });
  const [detail, setDetail] = useState<Load<QuizAttemptResult> | null>(null);

  const fail = useCallback(
    (error: unknown) => {
      if (isApiError(error, 401)) handleUnauthorized();
      return describeApiError(error, locale);
    },
    [handleUnauthorized, locale],
  );

  const load = useCallback(
    async (cursor?: string) => {
      try {
        const page = await api.listQuizResults(courseId, quizId, { limit: 50, cursor });
        setState((current) => ({
          status: 'ready',
          data: {
            items: cursor && current.status === 'ready' ? [...current.data.items, ...page.items] : page.items,
            nextCursor: page.nextCursor,
          },
        }));
      } catch (error) {
        setState({ status: 'error', message: fail(error) });
      }
    },
    [courseId, quizId, fail],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (attemptId: string) => {
    setDetail({ status: 'loading' });
    try {
      setDetail({ status: 'ready', data: await api.getQuizResult(courseId, quizId, attemptId) });
    } catch (error) {
      setDetail({ status: 'error', message: fail(error) });
    }
  };

  return (
    <Card as="section" aria-labelledby="results-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="results-heading" className="text-lg font-semibold text-brand-600">
          {r.heading}
        </h2>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          {r.refresh}
        </Button>
      </div>
      <p className="text-sm text-slate-600">{r.note}</p>
      {canRelease ? <ReleaseGradesButton courseId={courseId} activityId={quizId} label={r.release} /> : null}
      {state.status === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          {r.loading}
        </p>
      ) : state.status === 'error' ? (
        <Alert tone="error">{state.message}</Alert>
      ) : state.data.items.length === 0 ? (
        <p className="text-sm text-slate-600">{r.empty}</p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {r.student}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {r.attempt}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {r.status}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {r.submitted}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {r.score}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t.assessment.passedColumn}
                </th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">{r.details}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.data.items.map((row) => (
                <tr key={row.attemptId} className="border-b border-slate-100">
                  <td className="py-2 pr-4">
                    <span className="block text-slate-900">
                      {row.student.givenName} {row.student.familyName}
                    </span>
                    <span className="block text-xs break-all text-slate-500">{row.student.email}</span>
                  </td>
                  <td className="py-2 pr-4">{row.attemptNumber}</td>
                  <td className="py-2 pr-4">{attemptStatusLabel(row, r)}</td>
                  <td className="py-2 pr-4">{formatDateTimeOrDash(row.submittedAt, locale)}</td>
                  <td className="py-2 pr-4 font-medium">{row.score === null ? '—' : `${row.score} / ${row.maxScore}`}</td>
                  <td className="py-2 pr-4">{row.passed === null ? '—' : row.passed ? t.assessment.yes : t.assessment.no}</td>
                  <td className="py-2">
                    <Button variant="ghost" size="sm" onClick={() => void openDetail(row.attemptId)}>
                      {r.view}
                      <span className="sr-only"> {r.viewSr(row.attemptNumber, row.student.email)}</span>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {state.status === 'ready' && state.data.nextCursor ? (
        <Button variant="secondary" size="sm" onClick={() => void load(state.data.nextCursor ?? undefined)}>
          {r.loadMore}
        </Button>
      ) : null}
      {detail ? <AttemptDetail detail={detail} onClose={() => setDetail(null)} /> : null}
    </Card>
  );
}

function AttemptDetail({ detail, onClose }: { detail: Load<QuizAttemptResult>; onClose: () => void }) {
  const { t } = useLocale();
  const r = t.quiz.results;
  if (detail.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {r.loadingDetail}
      </p>
    );
  }
  if (detail.status === 'error') return <Alert tone="error">{detail.message}</Alert>;
  const attempt = detail.data;
  return (
    <section aria-labelledby="attempt-detail-heading" className="space-y-3 border-t border-slate-200 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="attempt-detail-heading" className="font-semibold text-slate-900">
          {r.detailHeading(`${attempt.student.givenName} ${attempt.student.familyName}`, attempt.attemptNumber)}{' '}
          {attempt.score === null ? r.notGraded : `${attempt.score} / ${attempt.maxScore}`}
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {r.close}
        </Button>
      </div>
      <ol className="space-y-3">
        {attempt.questions.map((question, index) => {
          const selected = new Set(question.selectedOptionIds);
          return (
            <li key={question.questionId} className="rounded-lg border border-slate-200 p-3 text-sm">
              <p className="font-medium break-words text-slate-900">
                {index + 1}. {question.prompt}
              </p>
              <p className="text-xs text-slate-500">
                {t.quiz.questionTypes[question.type]} · {r.awarded(question.awardedPoints === null ? '—' : String(question.awardedPoints), question.points)}
                {question.isCorrect === null ? '' : ` · ${question.isCorrect ? r.correct : r.incorrect}`}
              </p>
              <ul className="mt-2 space-y-1">
                {question.options.map((option) => (
                  <li key={option.id} className="text-slate-700">
                    {selected.has(option.id) ? '☑ ' : '☐ '}
                    {option.text}
                    {selected.has(option.id) ? ` ${r.selected}` : ''}
                    {option.isCorrect ? ` ${r.correctAnswer}` : ''}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
