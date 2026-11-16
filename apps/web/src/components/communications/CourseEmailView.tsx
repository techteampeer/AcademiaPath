'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { CourseEmailRecipients, CurrentUser } from '@/lib/api/types';
import { composePlan } from '@/lib/mailto';

type Load = { status: 'loading' } | { status: 'forbidden' } | { status: 'not-found' } | { status: 'error'; message: string } | { status: 'ready'; data: CourseEmailRecipients };
type Notice = { tone: 'info' | 'success' | 'error'; text: string } | null;

const textareaClasses = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm';
/** From this many recipients, mention that e-mail providers may limit recipients per message. */
const LARGE_CLASS = 50;

export function CourseEmailView({ courseId }: { courseId: string }) {
  return <RequireAuth>{(user) => <Content courseId={courseId} user={user} />}</RequireAuth>;
}

/**
 * AP-044: compose one e-mail to the course's active students in the user's own e-mail application (students in BCC).
 * Nothing is sent by AcademiaPath, so this page never reports an e-mail as sent.
 */
function Content({ courseId, user }: { courseId: string; user: CurrentUser }) {
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const m = t.courseEmail;
  const [state, setState] = useState<Load>({ status: 'loading' });
  useEffect(() => {
    api
      .getCourseEmailRecipients(courseId)
      .then((data) => setState({ status: 'ready', data }))
      .catch((error: unknown) => {
        if (isApiError(error, 401)) handleUnauthorized();
        else if (isApiError(error, 403)) setState({ status: 'forbidden' });
        else if (isApiError(error, 404) || isApiError(error, 400)) setState({ status: 'not-found' });
        else setState({ status: 'error', message: describeApiError(error, locale) });
      });
  }, [courseId, handleUnauthorized, locale]);

  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {m.loading}
      </p>
    );
  }
  if (state.status === 'forbidden') return <EmptyState titleAs="h1" title={m.title} description={m.forbidden} />;
  if (state.status === 'not-found') return <EmptyState titleAs="h1" title={m.notFound} />;
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>;
  return <Composer data={state.data} self={user.email} />;
}

function Composer({ data, self }: { data: CourseEmailRecipients; self: string }) {
  const { t } = useLocale();
  const m = t.courseEmail;
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [showAddresses, setShowAddresses] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const addresses = useMemo(() => data.recipients.map((recipient) => recipient.email), [data.recipients]);
  const plan = useMemo(() => composePlan({ self, recipients: addresses, subject, body }), [self, addresses, subject, body]);
  const { course, recipientCount, excluded } = data;

  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ tone: 'success', text: done });
    } catch {
      setShowAddresses(true);
      setNotice({ tone: 'error', text: m.send.copyFailed });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={m.title}
        kicker={course.code}
        breadcrumbLabel={t.common.breadcrumb}
        breadcrumbs={[{ label: t.nav.myCourses, href: '/courses' }, { label: course.title, href: `/courses/${course.id}` }, { label: m.navLabel }]}
      />
      <Alert tone="info">
        <span className="block">{m.intro}</span>
        <span className="mt-1 block">{m.internal}</span>
      </Alert>

      <Card as="section" aria-labelledby="email-recipients-heading" className="space-y-3" data-recipient-count={recipientCount}>
        <h2 id="email-recipients-heading" className="font-semibold text-brand-600">
          {m.recipients.heading}
        </h2>
        {recipientCount === 0 ? (
          <p className="text-sm text-slate-700" data-recipients-empty>
            {m.recipients.none}
          </p>
        ) : (
          <>
            <p className="text-sm font-medium text-slate-900">{m.recipients.count(recipientCount)}</p>
            <p className="text-sm text-slate-600">{m.recipients.privacy}</p>
          </>
        )}
        {excluded.invalidEmail > 0 ? <p className="text-sm text-amber-800">{m.recipients.invalid(excluded.invalidEmail)}</p> : null}
        {excluded.duplicateEmail > 0 ? <p className="text-sm text-slate-600">{m.recipients.duplicate(excluded.duplicateEmail)}</p> : null}
        {recipientCount > 0 ? (
          <details className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
            <summary className="cursor-pointer font-medium text-brand-700">{m.recipients.show}</summary>
            <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto" data-recipient-list>
              {data.recipients.map((recipient) => (
                <li key={recipient.email} className="break-words">
                  <span className="text-slate-900">{recipient.name}</span> <span className="break-all text-slate-500">{recipient.email}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Card>

      {recipientCount > 0 ? (
        <>
          <Card as="section" aria-labelledby="email-message-heading" className="space-y-3">
            <h2 id="email-message-heading" className="font-semibold text-brand-600">
              {m.message.heading}
            </h2>
            <TextField id="email-subject" label={m.message.subject} maxLength={200} value={subject} onChange={(event) => setSubject(event.target.value)} />
            <div>
              <label htmlFor="email-body" className="block text-sm font-medium text-slate-800">
                {m.message.body}
              </label>
              <textarea
                id="email-body"
                rows={8}
                maxLength={5000}
                value={body}
                aria-describedby="email-body-hint"
                onChange={(event) => setBody(event.target.value)}
                className={textareaClasses}
              />
              <p id="email-body-hint" className="mt-1 text-xs text-slate-500">
                {m.message.bodyHint}
              </p>
            </div>
          </Card>

          <Card as="section" aria-labelledby="email-send-heading" className="space-y-3" data-compose-mode={plan.mode}>
            <h2 id="email-send-heading" className="font-semibold text-brand-600">
              {m.send.heading}
            </h2>
            <p className="text-sm text-slate-700">{m.send.behaviour}</p>
            {plan.mode === 'paste-bcc' ? <Alert tone="info">{m.send.longList}</Alert> : null}
            {plan.mode === 'copy-all' ? <Alert tone="info">{m.send.longMessage}</Alert> : null}
            {recipientCount >= LARGE_CLASS || plan.mode !== 'complete' ? <p className="text-sm text-slate-600">{m.send.providerLimit}</p> : null}
            <div className="flex flex-wrap gap-2">
              <a href={plan.href} className={buttonClasses({})} data-mailto onClick={() => setNotice({ tone: 'info', text: m.send.opened })}>
                {m.send.open}
              </a>
              <Button variant="secondary" onClick={() => void copy(plan.bccText, m.send.bccCopied)}>
                {m.send.copyBcc}
              </Button>
              {plan.mode === 'copy-all' ? (
                <Button variant="secondary" onClick={() => void copy(body, m.send.messageCopied)}>
                  {m.send.copyMessage}
                </Button>
              ) : null}
              <Button variant="ghost" aria-expanded={showAddresses} aria-controls="email-bcc-addresses" onClick={() => setShowAddresses((value) => !value)}>
                {showAddresses ? m.send.hideAddresses : m.send.showAddresses}
              </Button>
            </div>
            {showAddresses ? (
              <div>
                <label htmlFor="email-bcc-addresses" className="block text-sm font-medium text-slate-800">
                  {m.send.addressesLabel}
                </label>
                <textarea id="email-bcc-addresses" readOnly rows={4} value={plan.bccText} onFocus={(event) => event.currentTarget.select()} className={textareaClasses} />
              </div>
            ) : null}
            <div role="status" aria-live="polite">
              {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
            </div>
            <p className="text-xs text-slate-500">{m.send.noClient}</p>
          </Card>
        </>
      ) : null}
    </div>
  );
}
