'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { contentAbilities } from '@/components/content/contentDisplay';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Breadcrumbs } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type {
  Course,
  CurrentUser,
  TutorGuideAction,
  TutorGuideBlock,
  TutorGuideReference,
  TutorGuideResponse,
  TutorLanguage,
  TutorPracticeCheckResponse,
  TutorSuggestedAction,
} from '@/lib/api/types';
import type { Messages } from '@/lib/i18n/messages';

const QUESTION_LIMIT = 500;

type Strings = Messages['tutor'];
type Material = TutorGuideResponse['materials'][number];
/** One exchange: what the person asked for (none for the automatic start) and the tutor's response. */
type Turn = {
  id: number;
  label: string | null;
  response: TutorGuideResponse;
  check: { optionId: string; response: TutorPracticeCheckResponse } | null;
};

/**
 * Guided demo tutor (AP-030D). Every response comes from the API, which answers deterministically from the course's
 * approved material in the interface language; nothing is generated, translated or stored. The conversation lives
 * only in this page's memory.
 */
export function TutorView({ courseId, initialActivityId }: { courseId: string; initialActivityId: string | null }) {
  return <RequireAuth>{(user) => <TutorContent courseId={courseId} initialActivityId={initialActivityId} user={user} />}</RequireAuth>;
}

function TutorContent({ courseId, initialActivityId, user }: { courseId: string; initialActivityId: string | null; user: CurrentUser }) {
  const { handleUnauthorized, getCsrfToken } = useSession();
  const { t: messages, locale } = useLocale();
  const t = messages.tutor;
  const [course, setCourse] = useState<{ status: 'loading' | 'missing' | 'error' } | { status: 'ready'; data: Course }>({ status: 'loading' });
  const [lessonId, setLessonId] = useState<string | null>(initialActivityId);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown (in the current language) when the requested lesson is not available to this person.
  const [lessonUnavailable, setLessonUnavailable] = useState(false);
  const [question, setQuestion] = useState('');
  const [questionError, setQuestionError] = useState<string | null>(null);
  const nextId = useRef(1);
  const variants = useRef(new Map<string, number>());
  const focusTarget = useRef<string | null>(null);
  // Read when a request is sent, so changing the language never restarts the conversation.
  const localeRef = useRef<TutorLanguage>(locale);
  localeRef.current = locale;
  const turnCount = useRef(0);
  turnCount.current = turns.length;
  const materialsRef = useRef(materials);
  materialsRef.current = materials;

  useEffect(() => {
    api
      .getCourse(courseId)
      .then((data) => setCourse({ status: 'ready', data }))
      .catch((failure: unknown) => {
        if (isApiError(failure, 401)) handleUnauthorized();
        else setCourse({ status: isApiError(failure, 404) || isApiError(failure, 400) ? 'missing' : 'error' });
      });
  }, [courseId, handleUnauthorized]);

  const allowed = course.status === 'ready' && contentAbilities(user, course.data.viewerRole).tutor;

  /** Sends one guided request. A lesson that is no longer available switches the context to the whole course. */
  const send = useCallback(
    async (action: TutorGuideAction, extra: { question?: string; variant?: number } = {}) => {
      setPending(true);
      setError(null);
      try {
        const response = await api.guideTutor(
          courseId,
          { action, language: localeRef.current, ...(lessonId ? { activityId: lessonId } : {}), ...extra },
          await getCsrfToken(),
        );
        return response;
      } catch (failure) {
        if (isApiError(failure, 401)) handleUnauthorized();
        else if (lessonId && isApiError(failure, 404)) {
          setLessonUnavailable(true);
          setLessonId(null);
        } else setError(describeApiError(failure, localeRef.current));
        return null;
      } finally {
        setPending(false);
      }
    },
    [courseId, lessonId, getCsrfToken, handleUnauthorized],
  );

  const append = useCallback((label: string | null, response: TutorGuideResponse, focus: boolean) => {
    const id = nextId.current++;
    if (response.action === 'start') setMaterials(response.materials);
    setTurns((current) => [...current, { id, label, response, check: null }]);
    if (focus) focusTarget.current = `tutor-turn-${id}`;
  }, []);

  // Opening the tutor starts from the lesson or course; choosing another lesson later continues with the new context.
  useEffect(() => {
    if (!allowed) return;
    let active = true;
    const continuing = turnCount.current > 0;
    const title = materialsRef.current.find((material) => material.activityId === lessonId)?.title ?? null;
    void send('start', { variant: continuing ? 1 : 0 }).then((response) => {
      if (active && response) append(continuing ? messages.tutor.startLabel(title) : null, response, continuing);
    });
    return () => {
      active = false;
    };
    // `send` changes with the lesson, which is exactly when the context changes; the label's language is not a reason to restart.
  }, [allowed, send, append]);

  // A conversation that has only the automatic greeting follows a language change; longer ones are kept as they are.
  const previousLocale = useRef(locale);
  useEffect(() => {
    if (previousLocale.current === locale) return;
    previousLocale.current = locale;
    if (turns.length !== 1 || turns[0]!.response.action !== 'start') return;
    void send('start').then((response) => {
      if (!response) return;
      setMaterials(response.materials);
      setTurns((current) => (current.length === 1 ? [{ ...current[0]!, response }] : current));
    });
  }, [locale, turns, send]);

  // Move keyboard and screen reader focus to each new response the person asked for.
  useEffect(() => {
    if (!focusTarget.current) return;
    document.getElementById(focusTarget.current)?.focus();
    focusTarget.current = null;
  }, [turns]);

  const choose = async (action: TutorSuggestedAction) => {
    const key = `${lessonId ?? 'course'}:${action === 'again' ? 'explain' : action}`;
    let variant = 0;
    if (action === 'explain') variants.current.set(key, 1);
    else if (action === 'again' || action === 'practice') {
      variant = variants.current.get(key) ?? (action === 'again' ? 1 : 0);
      variants.current.set(key, variant + 1);
    }
    const response = await send(action, { variant });
    if (response) append(t.actions[action], response, true);
  };

  const ask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = question.trim();
    if (!text) return setQuestionError(t.empty);
    if (text.length > QUESTION_LIMIT) return setQuestionError(messages.errors.maxChars(QUESTION_LIMIT));
    setQuestionError(null);
    const response = await send('ask', { question: text });
    if (response) {
      append(text, response, true);
      setQuestion('');
    }
  };

  const checkAnswer = async (turnId: number, questionId: string, optionId: string) => {
    setPending(true);
    setError(null);
    try {
      const response = await api.checkTutorPractice(courseId, questionId, optionId, localeRef.current, await getCsrfToken());
      setTurns((current) => current.map((turn) => (turn.id === turnId ? { ...turn, check: { optionId, response } } : turn)));
      focusTarget.current = `tutor-feedback-${turnId}`;
    } catch (failure) {
      if (isApiError(failure, 401)) handleUnauthorized();
      else setError(describeApiError(failure, localeRef.current));
    } finally {
      setPending(false);
    }
  };

  const restart = async () => {
    variants.current.clear();
    setLessonUnavailable(false);
    const response = await send('start');
    if (response) {
      setTurns([]);
      append(null, response, true);
    }
  };

  const backLink = (
    <Link href={`/courses/${courseId}`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
      {messages.content.view.backToCourse}
    </Link>
  );
  if (course.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {t.loading}
      </p>
    );
  }
  if (course.status !== 'ready' || !allowed) {
    return <EmptyState titleAs="h1" title={t.heading} description={t.unavailable} action={backLink} />;
  }

  const last = turns.at(-1);
  const followUps = last ? (last.check?.response.followUps ?? last.response.followUps) : [];
  const lesson = materials.find((material) => material.activityId === lessonId) ?? null;
  const sections = materials.reduce<Array<{ title: string; items: Material[] }>>((groups, material) => {
    const group = groups.at(-1);
    if (group && group.title === material.sectionTitle) group.items.push(material);
    else groups.push({ title: material.sectionTitle, items: [material] });
    return groups;
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs
          label={messages.common.breadcrumb}
          items={[{ label: messages.nav.myCourses, href: '/courses' }, { label: course.data.title, href: `/courses/${course.data.id}` }, { label: t.heading }]}
        />
        <p className="mt-4 text-sm text-slate-500">{course.data.code}</p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-[1.75rem] leading-tight font-semibold text-brand-600 sm:text-[2.1rem]">{t.heading}</h1>
          <Badge tone="warning" wrap>
            {t.badge}
          </Badge>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">{t.note}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] lg:items-start">
        <Card as="section" aria-labelledby="tutor-context-heading" className="space-y-4 lg:sticky lg:top-6">
          <h2 id="tutor-context-heading" className="text-lg font-semibold text-brand-600">
            {t.contextHeading}
          </h2>
          <p className="text-sm font-medium break-words text-slate-900">{course.data.title}</p>
          <div>
            <label htmlFor="tutor-lesson" className="block text-sm font-medium text-slate-800">
              {t.lesson}
            </label>
            <select
              id="tutor-lesson"
              value={lesson ? lesson.activityId : ''}
              disabled={pending || materials.length === 0}
              aria-describedby="tutor-lesson-hint"
              onChange={(event) => {
                setLessonUnavailable(false);
                setLessonId(event.target.value || null);
              }}
              className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
            >
              <option value="">{t.wholeCourse}</option>
              {sections.map((section) => (
                <optgroup key={section.title} label={section.title}>
                  {section.items.map((material) => (
                    <option key={material.activityId} value={material.activityId}>
                      {material.title}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <p id="tutor-lesson-hint" className="mt-1 text-xs text-slate-500">
              {t.lessonHint}
            </p>
          </div>
          {lesson ? (
            <Link href={`/courses/${courseId}/activities/${lesson.activityId}`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
              {t.openLesson}
            </Link>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => void restart()} disabled={pending}>
            {t.restart}
          </Button>
        </Card>

        <section aria-labelledby="tutor-conversation-heading" className="min-w-0 space-y-4">
          <h2 id="tutor-conversation-heading" className="sr-only">
            {t.conversation}
          </h2>
          {lessonUnavailable ? <Alert tone="info">{t.lessonUnavailable}</Alert> : null}
          <div role="log" aria-labelledby="tutor-conversation-heading" className="space-y-4">
            {turns.map((turn) => (
              <TurnView
                key={turn.id}
                turn={turn}
                courseId={courseId}
                locale={locale}
                pending={pending}
                t={t}
                onCheck={(questionId, optionId) => void checkAnswer(turn.id, questionId, optionId)}
              />
            ))}
          </div>
          {pending ? (
            <p role="status" className="text-sm text-slate-600">
              {t.thinking}
            </p>
          ) : null}
          {error ? <Alert tone="error">{error}</Alert> : null}

          {followUps.length ? (
            <div role="group" aria-labelledby="tutor-suggestions-heading" className="space-y-2">
              <h3 id="tutor-suggestions-heading" className="text-sm font-semibold text-slate-800">
                {t.suggestions}
              </h3>
              <ul className="flex flex-wrap gap-2">
                {followUps.map((action) => (
                  <li key={action}>
                    <Button variant="secondary" size="sm" disabled={pending} onClick={() => void choose(action)}>
                      {t.actions[action]}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <form noValidate onSubmit={ask} className="space-y-2 border-t border-slate-200 pt-4" aria-labelledby="tutor-ask-heading">
            <h3 id="tutor-ask-heading" className="text-sm font-semibold text-slate-800">
              {t.askHeading}
            </h3>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <label htmlFor="tutor-question" className="sr-only">
                  {t.question}
                </label>
                <input
                  id="tutor-question"
                  type="text"
                  value={question}
                  maxLength={QUESTION_LIMIT}
                  autoComplete="off"
                  onChange={(event) => setQuestion(event.target.value)}
                  aria-invalid={questionError ? true : undefined}
                  aria-describedby={`tutor-question-hint${questionError ? ' tutor-question-error' : ''}`}
                  className={`block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ${questionError ? 'border-red-500' : 'border-slate-300'}`}
                />
              </div>
              <Button type="submit" disabled={pending}>
                {t.ask}
              </Button>
            </div>
            <p id="tutor-question-hint" className="text-xs text-slate-500">
              {t.questionHint(QUESTION_LIMIT)}
            </p>
            {questionError ? (
              <p id="tutor-question-error" className="text-sm text-red-700">
                {questionError}
              </p>
            ) : null}
          </form>
        </section>
      </div>
    </div>
  );
}

function TurnView({
  turn,
  courseId,
  locale,
  pending,
  t,
  onCheck,
}: {
  turn: Turn;
  courseId: string;
  locale: TutorLanguage;
  pending: boolean;
  t: Strings;
  onCheck: (questionId: string, optionId: string) => void;
}) {
  const { response } = turn;
  const anchor = `tutor-turn-${turn.id}`;
  // Feedback on a practice answer usually cites the question's own source: list it once.
  const sameSources =
    turn.check !== null &&
    turn.check.response.references.every((reference) => response.references.some((own) => own.ref === reference.ref && own.activityId === reference.activityId));
  return (
    <div className="space-y-3">
      {turn.label ? (
        <div className="flex justify-end">
          <p className="max-w-[85%] rounded-lg bg-brand-50 px-3 py-2 text-sm break-words text-brand-800">
            <span className="sr-only">{t.you}: </span>
            {turn.label}
          </p>
        </div>
      ) : null}
      <article aria-labelledby={anchor} lang={response.language} className="space-y-3 rounded-lg border border-slate-200 border-l-4 border-l-gold-400 bg-white p-4 shadow-panel">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={anchor} tabIndex={-1} className="text-sm font-semibold text-brand-700">
            {t.tutor}
          </h3>
          {response.grounding === 'insufficient_material' ? <Badge tone="neutral">{t.notFound}</Badge> : null}
          {response.language !== locale ? <span className="text-xs text-slate-500">{t.earlierLanguage(t.langNames[response.language] ?? response.language)}</span> : null}
        </div>
        <Blocks blocks={response.blocks} anchor={anchor} t={t} />
        {response.practice ? (
          <PracticeForm turnId={turn.id} practice={response.practice} references={response.references} check={turn.check} pending={pending} t={t} onCheck={onCheck} />
        ) : null}
        {turn.check ? (
          <div className="space-y-3 border-t border-slate-200 pt-3" lang={turn.check.response.language}>
            <h4 id={`tutor-feedback-${turn.id}`} tabIndex={-1} className="sr-only">
              {t.tutor}
            </h4>
            <Blocks blocks={turn.check.response.blocks} anchor={sameSources ? anchor : `${anchor}-check`} t={t} />
            {sameSources ? null : <References references={turn.check.response.references} anchor={`${anchor}-check`} courseId={courseId} t={t} />}
          </div>
        ) : null}
        <References references={response.references} anchor={anchor} courseId={courseId} t={t} />
      </article>
    </div>
  );
}

function sourceLang(language: TutorGuideBlock['sourceLanguage']) {
  return language === 'en' || language === 'es' ? language : undefined;
}

/** Tutor text, verbatim course quotes and lists (marked with their own language), and labelled study tips. */
function Blocks({ blocks, anchor, t }: { blocks: TutorGuideBlock[]; anchor: string; t: Strings }) {
  const cite = (ref: number | null) =>
    ref === null ? null : (
      <a href={`#${anchor}-ref-${ref}`} className="ml-1 text-xs font-medium text-brand-700 underline-offset-2 hover:underline">
        <span aria-hidden="true">[{ref}]</span>
        <span className="sr-only">{t.sourceLink(ref)}</span>
      </a>
    );
  return (
    <div className="space-y-2 text-sm text-slate-800">
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        if (block.kind === 'quote') {
          return (
            <blockquote key={key} className="border-l-4 border-slate-200 pl-3 whitespace-pre-wrap break-words text-slate-700">
              <span lang={sourceLang(block.sourceLanguage)}>{block.text}</span>
              {cite(block.ref)}
            </blockquote>
          );
        }
        if (block.kind === 'list') {
          return (
            <div key={key} className="flex items-start gap-1">
              <ul className="list-disc space-y-1 pl-5 break-words" lang={sourceLang(block.sourceLanguage)}>
                {block.items.map((item, position) => (
                  <li key={position}>{item}</li>
                ))}
              </ul>
              {cite(block.ref)}
            </div>
          );
        }
        if (block.kind === 'tip') {
          return (
            <p key={key} className="rounded-md bg-gold-100/60 px-3 py-2 break-words text-slate-800">
              {block.text}
            </p>
          );
        }
        return (
          <p key={key} className="break-words">
            {block.text}
          </p>
        );
      })}
    </div>
  );
}

function References({ references, anchor, courseId, t }: { references: TutorGuideReference[]; anchor: string; courseId: string; t: Strings }) {
  if (!references.length) return null;
  return (
    <section aria-label={t.sources} className="space-y-1 border-t border-slate-100 pt-3">
      <h4 className="text-xs font-semibold tracking-wide text-slate-600 uppercase">{t.sources}</h4>
      <ol className="space-y-1 text-sm">
        {references.map((reference) => (
          <li key={`${reference.ref}-${reference.activityId}`} id={`${anchor}-ref-${reference.ref}`} className="break-words">
            <span className="text-slate-500">[{reference.ref}]</span>{' '}
            <Link href={`/courses/${courseId}/activities/${reference.activityId}`} className="font-medium text-brand-700 hover:underline">
              <span lang={sourceLang(reference.sourceLanguage)}>{reference.title}</span>
            </Link>{' '}
            <span className="text-xs text-slate-500">
              · {t.refTypes[reference.type]} · <span lang={sourceLang(reference.sourceLanguage)}>{reference.sectionTitle}</span>
            </span>
            {!reference.matchesRequestedLanguage && reference.sourceLanguage ? (
              <span className="block text-xs text-amber-800">
                {reference.sourceLanguage === 'unknown' ? t.sourceUnknown : t.sourceIn(t.langNames[reference.sourceLanguage] ?? reference.sourceLanguage)}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function PracticeForm({
  turnId,
  practice,
  references,
  check,
  pending,
  t,
  onCheck,
}: {
  turnId: number;
  practice: NonNullable<TutorGuideResponse['practice']>;
  references: TutorGuideReference[];
  check: Turn['check'];
  pending: boolean;
  t: Strings;
  onCheck: (questionId: string, optionId: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const language = sourceLang(references.find((reference) => reference.ref === practice.ref)?.sourceLanguage ?? null);
  const name = `tutor-practice-${turnId}`;
  const correct = check?.response.correctOptionId ?? null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return setMissing(true);
    setMissing(false);
    onCheck(practice.questionId, selected);
  };

  return (
    <form noValidate onSubmit={submit} className="space-y-3 rounded-md bg-slate-50 p-3">
      <fieldset aria-describedby={missing ? `${name}-error` : undefined}>
        <legend className="text-sm font-semibold text-slate-900">{practice.prompt}</legend>
        <blockquote lang={language} className="mt-2 border-l-4 border-gold-400 pl-3 text-sm whitespace-pre-wrap break-words text-slate-800">
          {practice.statement}
        </blockquote>
        <div className="mt-3 space-y-2">
          {practice.options.map((option) => {
            const isCorrect = correct === option.id;
            const isChosen = check?.optionId === option.id;
            return (
              <label key={option.id} className="flex items-start gap-2 text-sm text-slate-800">
                <input
                  type="radio"
                  name={name}
                  value={option.id}
                  checked={(check?.optionId ?? selected) === option.id}
                  disabled={check !== null}
                  onChange={() => setSelected(option.id)}
                  className="mt-1"
                />
                <span className="break-words">
                  <span lang={practice.kind === 'term' ? language : undefined}>{option.text}</span>
                  {isCorrect ? <span className="ml-2 font-medium text-emerald-800">({t.correctAnswer})</span> : null}
                  {isChosen && !isCorrect ? <span className="ml-2 font-medium text-red-700">({t.yourAnswer})</span> : null}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {missing ? (
        <p id={`${name}-error`} className="text-sm text-red-700">
          {t.chooseOption}
        </p>
      ) : null}
      {check === null ? (
        <Button type="submit" size="sm" disabled={pending}>
          {t.check}
        </Button>
      ) : null}
    </form>
  );
}
