'use client';

import { useLocale } from '@/components/i18n/LocaleProvider';
import type { QuizContent } from '@/lib/api/types';

/** Quiz settings shown to staff and students. Contains no questions or answers. */
export function QuizSummary({ content }: { content: QuizContent }) {
  const { t } = useLocale();
  const s = t.quiz.summary;
  return (
    <div className="space-y-3">
      {content.instructions ? <p className="whitespace-pre-wrap break-words text-slate-800">{content.instructions}</p> : null}
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">{s.questions}</dt>
          <dd className="font-medium text-slate-900">{s.questionTotals(content.questionCount, content.totalPoints)}</dd>
        </div>
        <div>
          <dt className="text-slate-500">{s.attemptsAllowed}</dt>
          <dd className="font-medium text-slate-900">{content.attemptLimit}</dd>
        </div>
        <div>
          <dt className="text-slate-500">{s.timeLimit}</dt>
          <dd className="font-medium text-slate-900">{content.timeLimitMinutes ? s.minutes(content.timeLimitMinutes) : s.none}</dd>
        </div>
      </dl>
    </div>
  );
}
