'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Breadcrumbs } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Course, DocumentStudyBrief, StudyBriefReference, StudyBriefText } from '@/lib/api/types';
import type { Messages } from '@/lib/i18n/messages';
import { segmentCount, segmentLabel } from './documentDisplay';

type State = { status: 'loading' } | { status: 'missing' } | { status: 'error' } | { status: 'ready'; course: Course; data: DocumentStudyBrief };
type Brief = DocumentStudyBrief['brief'];

/**
 * AP-031D study brief of one course document. The API selects everything from the document's extracted text by fixed
 * rules and sends no wording of its own; every label and prompt here comes from the interface catalog, so switching
 * language keeps the brief as it is. Document text is always rendered as text (never HTML) in its own language.
 */
export function StudyBriefView({ courseId, activityId }: { courseId: string; activityId: string }) {
  return <RequireAuth>{() => <BriefContent courseId={courseId} activityId={activityId} />}</RequireAuth>;
}

/** "page 3" inside a sentence (the label is otherwise capitalized). */
const inSentence = (label: string) => label.charAt(0).toLocaleLowerCase() + label.slice(1);

function BriefContent({ courseId, activityId }: { courseId: string; activityId: string }) {
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const b = t.documents.brief;
  const [state, setState] = useState<State>({ status: 'loading' });
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed' | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [course, data] = await Promise.all([api.getCourse(courseId), api.getDocumentStudyBrief(courseId, activityId)]);
      setState({ status: 'ready', course, data });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      else setState({ status: isApiError(error, 404) || isApiError(error, 400) || isApiError(error, 403) ? 'missing' : 'error' });
    }
  }, [courseId, activityId, handleUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const documentHref = `/courses/${courseId}/activities/${activityId}`;
  const courseLink = (
    <Link href={`/courses/${courseId}`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
      {b.backToCourse}
    </Link>
  );
  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {b.loading}
      </p>
    );
  }
  if (state.status === 'missing') return <EmptyState titleAs="h1" title={b.heading} description={b.notAvailable} action={courseLink} />;
  if (state.status === 'error') {
    return (
      <div className="space-y-4">
        <h1 className="text-[1.75rem] leading-tight font-semibold text-brand-600">{b.heading}</h1>
        <Alert tone="error">
          {b.loadError}{' '}
          <button type="button" className="font-medium underline" onClick={() => void load()}>
            {t.common.retry}
          </button>
        </Alert>
      </div>
    );
  }

  const { course, data } = state;
  const brief = data.brief;
  const location = (ref: StudyBriefReference) => segmentLabel(t, ref.kind, ref.label);
  const sourceHref = (ref: StudyBriefReference) => `${documentHref}#segment-${ref.segmentIndex}`;
  const partial = brief.limitations.filter((item) => item.code !== 'few_sentences' && item.code !== 'no_text');
  const otherLanguage = brief.language.primary && brief.language.primary !== locale && !brief.language.mixed ? brief.language.primary : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plainText(t, data, location));
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs
          label={t.common.breadcrumb}
          items={[
            { label: t.nav.myCourses, href: '/courses' },
            { label: course.title, href: `/courses/${course.id}` },
            { label: data.title, href: documentHref },
            { label: b.heading },
          ]}
        />
        <p className="mt-4 text-sm text-slate-500">
          {course.code} · <span className="break-all">{data.document.fileName}</span> · {t.documents.formats[data.document.format]}
        </p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-[1.75rem] leading-tight font-semibold break-words text-brand-600 sm:text-[2.1rem]">
            {b.heading}: <span className="text-slate-800">{data.title}</span>
          </h1>
          <Badge tone="warning" wrap>
            {b.badge}
          </Badge>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">{b.explanation}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link href={documentHref} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
            {b.backToDocument}
          </Link>
          {brief.status !== 'no_text' ? (
            <Button variant="ghost" size="sm" onClick={() => void copy()}>
              {b.copy}
            </Button>
          ) : null}
          {data.version === 'working' ? <Badge tone="brand">{b.versionWorking}</Badge> : null}
        </div>
        {copyStatus ? (
          <p role="status" className={`mt-2 text-sm ${copyStatus === 'copied' ? 'text-emerald-800' : 'text-red-700'}`}>
            {copyStatus === 'copied' ? b.copied : b.copyFailed}
          </p>
        ) : null}
      </div>

      {brief.status === 'no_text' ? (
        <Alert tone="info">
          <p>{b.limitations.no_text}</p>
          <p className="mt-2">{b.noTextRecovery}</p>
          <a href={api.documentFileHref(courseId, activityId)} download className="mt-2 inline-block font-medium text-brand-700 underline">
            {t.documents.panel.download}
          </a>
        </Alert>
      ) : (
        <>
          {partial.length ? (
            <Alert tone="info">
              <p className="font-semibold">{b.partial}</p>
              <p>{b.partialIntro}</p>
              <ul className="mt-1 list-disc pl-5">
                {partial.map((item) => (
                  <li key={item.code}>{limitationText(t, locale, item)}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {otherLanguage ? <p className="text-sm text-slate-700">{b.sourceLanguage(b.languageNames[otherLanguage] ?? otherLanguage)}</p> : null}
          {brief.language.mixed ? <p className="text-sm text-slate-700">{b.mixedLanguage}</p> : null}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] lg:items-start">
            <Card as="article" aria-labelledby="brief-main-heading" className="min-w-0 space-y-6">
              <h2 id="brief-main-heading" className="sr-only">
                {b.heading}
              </h2>
              {brief.status === 'excerpts_only' ? (
                <BriefSection id="brief-excerpts-only" title={b.excerptsOnly} note={`${b.limitations.few_sentences} ${b.excerptsOnlyNote}`}>
                  <Quotes items={brief.excerpts} location={location} href={sourceHref} t={t} />
                </BriefSection>
              ) : (
                <>
                  <BriefSection id="brief-overview" title={b.overview} note={b.overviewNote}>
                    <Quotes items={brief.overview} location={location} href={sourceHref} t={t} />
                  </BriefSection>
                  <BriefSection id="brief-concepts" title={b.concepts} note={brief.concepts.length ? b.conceptsNote : b.noConcepts}>
                    {brief.concepts.length ? (
                      <dl className="space-y-3">
                        {brief.concepts.map((concept) => (
                          <div key={`${concept.ref.segmentIndex}-${concept.term}`}>
                            <dt className="font-semibold text-slate-900" lang={concept.language ?? undefined}>
                              {concept.term}
                            </dt>
                            <dd>
                              {brief.overview.some((item) => item.text === concept.text) ? (
                                <p className="text-sm text-slate-600">
                                  <Link href={sourceHref(concept.ref)} className="text-brand-700 hover:underline">
                                    {b.conceptInOverview(inSentence(location(concept.ref)))}
                                  </Link>
                                </p>
                              ) : (
                                <Quote item={{ text: concept.text, ref: concept.ref, language: concept.language, shortened: false }} location={location} href={sourceHref} t={t} />
                              )}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                  </BriefSection>
                  <BriefSection id="brief-excerpts" title={b.excerpts} note={b.excerptsNote}>
                    <Quotes items={brief.excerpts} location={location} href={sourceHref} t={t} />
                  </BriefSection>
                  {brief.reviewPoints.length ? (
                    <BriefSection id="brief-review" title={b.review} note={b.reviewNote}>
                      <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-800">
                        {brief.reviewPoints.map((point, index) => (
                          <li key={index} className="break-words">
                            {reviewPrompt(t, point)}{' '}
                            <Link href={sourceHref(point.ref)} className="text-xs whitespace-nowrap text-brand-700 hover:underline" aria-label={b.openLocation(inSentence(location(point.ref)))}>
                              ({location(point.ref)})
                            </Link>
                            {point.kind === 'list' ? (
                              <details className="mt-1">
                                <summary className="cursor-pointer text-brand-700">{b.showItems}</summary>
                                <ul className="mt-1 list-disc pl-5" lang={point.language ?? undefined}>
                                  {point.items.map((item) => (
                                    <li key={item}>{item}</li>
                                  ))}
                                </ul>
                              </details>
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    </BriefSection>
                  ) : null}
                </>
              )}
            </Card>

            <div className="min-w-0 space-y-6">
              <Card as="section" aria-labelledby="brief-topics" className="space-y-3">
                <h2 id="brief-topics" className="text-lg font-semibold text-brand-600">
                  {b.topics}
                </h2>
                {brief.outline.length ? (
                  <>
                    <p className="text-xs text-slate-500">{b.topicsNote}</p>
                    <ol className="space-y-1 text-sm">
                      {brief.outline.map((heading) => (
                        <li key={`${heading.ref.segmentIndex}-${heading.text}`} className="break-words">
                          <Link href={sourceHref(heading.ref)} className="font-medium text-brand-700 hover:underline" lang={brief.language.primary ?? undefined}>
                            {heading.text}
                          </Link>{' '}
                          <span className="text-xs text-slate-500">· {location(heading.ref)}</span>
                        </li>
                      ))}
                    </ol>
                    {brief.outlineTotal > brief.outline.length ? <p className="text-xs text-slate-500">{b.moreTopics(brief.outlineTotal - brief.outline.length)}</p> : null}
                  </>
                ) : (
                  <p className="text-sm text-slate-600">{b.noTopics}</p>
                )}
                {brief.keywords.length ? (
                  <div>
                    <h3 className="text-sm font-semibold text-slate-800">{b.keywords}</h3>
                    <ul className="mt-2 flex flex-wrap gap-2" lang={brief.language.primary ?? undefined}>
                      {brief.keywords.map((keyword) => (
                        <li key={keyword}>
                          <Badge>{keyword}</Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </Card>
              <Card as="section" aria-labelledby="brief-tips" className="space-y-2">
                <h2 id="brief-tips" className="text-lg font-semibold text-brand-600">
                  {b.tips}
                </h2>
                <p className="text-xs text-slate-500">{b.tipsNote}</p>
                <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
                  {b.tipList.map((tip) => (
                    <li key={tip}>{tip}</li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>
        </>
      )}

      <section aria-labelledby="brief-about" className="space-y-1 border-t border-slate-200 pt-4 text-xs text-slate-500">
        <h2 id="brief-about" className="text-sm font-semibold text-slate-700">
          {b.about}
        </h2>
        <p>{data.version === 'working' ? b.versionWorking : b.versionApproved}</p>
        {brief.status === 'complete' ? <p>{b.complete}</p> : null}
        <p>
          {b.coverage(
            brief.coverage.processedSegments,
            segmentCount(t, data.document.format, brief.coverage.totalSegments),
            brief.coverage.processedCharacters.toLocaleString(locale === 'es' ? 'es-PE' : 'en-US'),
          )}
        </p>
        {brief.cleanup.repeatedLinesRemoved || brief.cleanup.duplicateSentencesRemoved ? (
          <p>{b.cleanup(brief.cleanup.repeatedLinesRemoved, brief.cleanup.duplicateSentencesRemoved)}</p>
        ) : null}
      </section>
    </div>
  );
}

function BriefSection({ id, title, note, children }: { id: string; title: string; note: string; children?: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h2 id={id} className="text-lg font-semibold text-brand-600">
        {title}
      </h2>
      <p className="text-xs text-slate-500">{note}</p>
      {children}
    </section>
  );
}

function Quote({ item, location, href, t }: { item: StudyBriefText; location: (ref: StudyBriefReference) => string; href: (ref: StudyBriefReference) => string; t: Messages }) {
  const label = location(item.ref);
  return (
    <figure className="space-y-1">
      <blockquote lang={item.language ?? undefined} className="border-l-4 border-gold-400 pl-3 text-sm break-words whitespace-pre-wrap text-slate-800">
        {item.text}
      </blockquote>
      <figcaption className="pl-4 text-xs">
        <Link href={href(item.ref)} className="text-brand-700 hover:underline" aria-label={t.documents.brief.openLocation(inSentence(label))}>
          {t.documents.brief.from(inSentence(label))}
        </Link>
      </figcaption>
    </figure>
  );
}

function Quotes({ items, location, href, t }: { items: StudyBriefText[]; location: (ref: StudyBriefReference) => string; href: (ref: StudyBriefReference) => string; t: Messages }) {
  return (
    <div className="space-y-3">
      {items.map((item, index) => (
        <Quote key={`${item.ref.segmentIndex}-${index}`} item={item} location={location} href={href} t={t} />
      ))}
    </div>
  );
}

/** The review prompt in the interface language around the document's own term (quoted as written). */
function reviewPrompt(t: Messages, point: Brief['reviewPoints'][number]): string {
  const b = t.documents.brief;
  if (point.kind === 'concept' && point.term) return b.reviewConcept(point.term);
  if (point.kind === 'section' && point.term) return b.reviewSection(point.term);
  if (point.kind === 'list') return b.reviewList(point.items.length);
  return b.reviewExcerpt;
}

function limitationText(t: Messages, locale: 'en' | 'es', item: Brief['limitations'][number]): string {
  const l = t.documents.brief.limitations;
  const number = (value: number | null) => (value ?? 0).toLocaleString(locale === 'es' ? 'es-PE' : 'en-US');
  switch (item.code) {
    case 'brief_limit':
      return l.brief_limit(number(item.processed), number(item.total));
    case 'pages_without_text':
      return l.pages_without_text(item.processed ?? 0, item.total ?? 0);
    default:
      return l[item.code];
  }
}

/** The brief as plain text for the clipboard (labels in the interface language, document text as written). */
function plainText(t: Messages, data: DocumentStudyBrief, location: (ref: StudyBriefReference) => string): string {
  const b = t.documents.brief;
  const { brief } = data;
  const quote = (item: { text: string; ref: StudyBriefReference }) => `“${item.text}” (${location(item.ref)})`;
  const lines = [`${b.heading}: ${data.title}`, b.badge, ''];
  const block = (heading: string, items: string[]) => {
    if (items.length) lines.push(heading, ...items, '');
  };
  block(brief.status === 'excerpts_only' ? b.excerptsOnly : b.copyHeadings.overview, (brief.status === 'excerpts_only' ? brief.excerpts : brief.overview).map(quote));
  block(b.copyHeadings.topics, brief.outline.map((heading) => `- ${heading.text} (${location(heading.ref)})`));
  block(b.copyHeadings.concepts, brief.concepts.map((concept) => `- ${concept.term}: ${quote(concept)}`));
  if (brief.status !== 'excerpts_only') block(b.copyHeadings.excerpts, brief.excerpts.map(quote));
  block(
    b.copyHeadings.review,
    brief.reviewPoints.map((point) => {
      const items = point.kind === 'list' ? ` (${point.items.join('; ')})` : '';
      return `- ${reviewPrompt(t, point)}${items} (${location(point.ref)})`;
    }),
  );
  return lines.join('\n').trim();
}
