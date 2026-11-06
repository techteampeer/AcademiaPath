'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { contentAbilities } from '@/components/content/contentDisplay';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Breadcrumbs } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Course, CurrentUser, TutorCitation, TutorLanguage, TutorMessageResponse, TutorPracticeResponse, TutorUsage } from '@/lib/api/types';
import type { Messages } from '@/lib/i18n/messages';

const QUESTION_LIMIT = 500;
const TOPIC_LIMIT = 200;

type Strings = Messages['tutor'];

export function TutorView({ courseId }: { courseId: string }) {
  return <RequireAuth>{(user) => <TutorContent courseId={courseId} user={user} />}</RequireAuth>;
}

function TutorContent({ courseId, user }: { courseId: string; user: CurrentUser }) {
  const { handleUnauthorized } = useSession();
  // Interface strings follow the application language; answers default to it but can be requested in the other language.
  const { t: messages, locale } = useLocale();
  const t = messages.tutor;
  const [language, setLanguage] = useState<TutorLanguage>(locale);
  const [course, setCourse] = useState<{ status: 'loading' | 'missing' | 'error' } | { status: 'ready'; data: Course }>({ status: 'loading' });
  const [usage, setUsage] = useState<TutorUsage | null>(null);
  // Switching the interface language also switches the default response language.
  useEffect(() => setLanguage(locale), [locale]);

  useEffect(() => {
    api
      .getCourse(courseId)
      .then((data) => setCourse({ status: 'ready', data }))
      .catch((error: unknown) => {
        if (isApiError(error, 401)) handleUnauthorized();
        else setCourse({ status: isApiError(error, 404) || isApiError(error, 400) ? 'missing' : 'error' });
      });
  }, [courseId, handleUnauthorized]);

  const refreshUsage = useCallback(() => {
    api.tutorUsage(courseId).then(setUsage).catch(() => setUsage(null));
  }, [courseId]);

  const allowed = course.status === 'ready' && contentAbilities(user, course.data.viewerRole).tutor;
  useEffect(() => {
    if (allowed) refreshUsage();
  }, [allowed, refreshUsage]);

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

  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs
          label={messages.common.breadcrumb}
          items={[{ label: messages.nav.myCourses, href: '/courses' }, { label: course.data.title, href: `/courses/${course.data.id}` }, { label: t.heading }]}
        />
        <p className="mt-4 text-sm text-slate-500">{course.data.code}</p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{t.heading}</h1>
          <Badge tone="warning">{t.mock}</Badge>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">{t.mockNote}</p>
      </div>

      <fieldset className="flex flex-wrap items-center gap-4">
        <legend className="mb-1 text-sm font-medium text-slate-800">{t.language}</legend>
        {(['en', 'es'] as const).map((option) => (
          <label key={option} lang={option} className="flex items-center gap-2 text-sm text-slate-800">
            <input type="radio" name="tutor-language" value={option} checked={language === option} onChange={() => setLanguage(option)} />
            {option === 'en' ? 'English' : 'Español'}
          </label>
        ))}
      </fieldset>

      <QuestionPanel courseId={courseId} language={language} t={t} onDone={refreshUsage} />
      <PracticePanel courseId={courseId} language={language} t={t} onDone={refreshUsage} />
      {usage ? <p className="text-xs text-slate-500">{t.usage(usage.usedInWindow, usage.limit, usage.windowMinutes)}</p> : null}
    </div>
  );
}

function CitationList({ courseId, citations, t }: { courseId: string; citations: TutorCitation[]; t: Strings }) {
  return (
    <section aria-label={t.sources} className="space-y-3">
      <h3 className="font-semibold text-slate-900">{t.sources}</h3>
      <ol className="space-y-3">
        {citations.map((citation) => (
          <li key={`${citation.ref}-${citation.activityId}`} className="rounded-lg border border-slate-200 p-3">
            <p className="text-sm font-medium text-slate-900">
              [{citation.ref}]{' '}
              <Link href={`/courses/${courseId}/activities/${citation.activityId}`} className="text-brand-700 hover:underline">
                {citation.title}
              </Link>
            </p>
            {!citation.matchesRequestedLanguage ? (
              <p className="text-xs text-amber-800">
                {citation.sourceLanguage === 'unknown' ? t.sourceUnknown : t.sourceIn(t.langNames[citation.sourceLanguage] ?? citation.sourceLanguage)}
              </p>
            ) : null}
            <blockquote lang={citation.sourceLanguage === 'unknown' ? undefined : citation.sourceLanguage} className="mt-2 border-l-4 border-slate-200 pl-3 text-sm whitespace-pre-wrap break-words text-slate-700">
              {citation.excerpt}
            </blockquote>
          </li>
        ))}
      </ol>
    </section>
  );
}

function QuestionPanel({ courseId, language, t, onDone }: { courseId: string; language: TutorLanguage; t: Strings; onDone: () => void }) {
  const errorText = useLocale().t.errors;
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<TutorMessageResponse | null>(null);
  const { run, pending, result } = useCsrfAction();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!question.trim()) return setError(t.empty);
    if (question.length > QUESTION_LIMIT) return setError(errorText.maxChars(QUESTION_LIMIT));
    setError(null);
    const answer = await run((csrf) => api.askTutor(courseId, question.trim(), language, csrf));
    if (answer) setResponse(answer);
    onDone();
  };

  return (
    <Card as="section" aria-labelledby="tutor-question-heading" className="space-y-4">
      <h2 id="tutor-question-heading" className="text-lg font-semibold text-slate-900">
        {t.askHeading}
      </h2>
      <form noValidate onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor="tutor-question" className="sr-only">
            {t.question}
          </label>
          <textarea
            id="tutor-question"
            rows={3}
            maxLength={QUESTION_LIMIT}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={`tutor-question-hint${error ? ' tutor-question-error' : ''}`}
            className={`block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ${error ? 'border-red-500' : 'border-slate-300'}`}
          />
          <p id="tutor-question-hint" className="mt-1 text-xs text-slate-500">
            {t.questionHint(QUESTION_LIMIT)}
          </p>
          {error ? (
            <p id="tutor-question-error" className="mt-1 text-sm text-red-700">
              {error}
            </p>
          ) : null}
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? t.asking : t.ask}
        </Button>
      </form>
      {pending ? (
        <p role="status" className="text-sm text-slate-600">
          {t.asking}
        </p>
      ) : null}
      {result?.tone === 'error' ? <Alert tone="error">{result.message}</Alert> : null}
      {response ? (
        <section aria-labelledby="tutor-response-heading" className="space-y-3 border-t border-slate-200 pt-4" lang={response.language}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="tutor-response-heading" className="font-semibold text-slate-900">
              {response.grounding === 'grounded' ? t.response : t.insufficient}
            </h3>
            <Badge tone="warning">{response.provider.label}</Badge>
          </div>
          {response.grounding === 'insufficient_material' ? (
            <Alert tone="info">{response.text}</Alert>
          ) : (
            <p className="text-sm whitespace-pre-wrap break-words text-slate-800">{response.text}</p>
          )}
          {response.citations.length ? <CitationList courseId={courseId} citations={response.citations} t={t} /> : null}
        </section>
      ) : null}
    </Card>
  );
}

function PracticePanel({ courseId, language, t, onDone }: { courseId: string; language: TutorLanguage; t: Strings; onDone: () => void }) {
  const [topic, setTopic] = useState('');
  const [practice, setPractice] = useState<TutorPracticeResponse | null>(null);
  const { run, pending, result } = useCsrfAction();

  const suggest = async () => {
    const value = topic.trim().slice(0, TOPIC_LIMIT);
    const prompts = await run((csrf) => api.tutorPractice(courseId, language, value || null, csrf));
    if (prompts) setPractice(prompts);
    onDone();
  };

  return (
    <Card as="section" aria-labelledby="tutor-practice-heading" className="space-y-4">
      <h2 id="tutor-practice-heading" className="text-lg font-semibold text-slate-900">
        {t.practiceHeading}
      </h2>
      <p className="text-sm text-slate-600">{t.practiceNote}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <label htmlFor="tutor-topic" className="block text-sm font-medium text-slate-800">
            {t.topic}
          </label>
          <input
            id="tutor-topic"
            value={topic}
            maxLength={TOPIC_LIMIT}
            onChange={(event) => setTopic(event.target.value)}
            className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
          />
        </div>
        <Button variant="secondary" onClick={() => void suggest()} disabled={pending}>
          {pending ? t.suggesting : t.suggest}
        </Button>
      </div>
      {result?.tone === 'error' ? <Alert tone="error">{result.message}</Alert> : null}
      {practice ? (
        practice.prompts.length === 0 ? (
          <Alert tone="info">{t.noPractice}</Alert>
        ) : (
          <div className="space-y-3" lang={practice.language}>
            <Badge tone="warning">{practice.provider.label}</Badge>
            <ol className="space-y-2">
              {practice.prompts.map((prompt) => (
                <li key={`${prompt.kind}-${prompt.ref}`} className="rounded-lg border border-slate-200 p-3 text-sm text-slate-800">
                  <p className="whitespace-pre-wrap break-words">{prompt.text}</p>
                  <Link href={`/courses/${courseId}/activities/${prompt.citation.activityId}`} className="mt-1 inline-block text-xs text-brand-700 hover:underline">
                    {t.openLesson}: {prompt.citation.title}
                  </Link>
                </li>
              ))}
            </ol>
          </div>
        )
      ) : null}
    </Card>
  );
}
