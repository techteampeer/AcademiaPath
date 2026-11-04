import type { QuizContent, QuizQuestionType } from '@/lib/api/types';

export const QUESTION_TYPE_LABELS: Record<QuizQuestionType, string> = {
  single_choice: 'Single answer',
  multiple_choice: 'Multiple answers',
  true_false: 'True / false',
};

export function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

/** Quiz settings shown to staff and students. Contains no questions or answers. */
export function QuizSummary({ content }: { content: QuizContent }) {
  return (
    <div className="space-y-3">
      {content.instructions ? <p className="whitespace-pre-wrap break-words text-slate-800">{content.instructions}</p> : null}
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">Questions</dt>
          <dd className="font-medium text-slate-900">
            {content.questionCount} ({content.totalPoints} points)
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Attempts allowed</dt>
          <dd className="font-medium text-slate-900">{content.attemptLimit}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Time limit</dt>
          <dd className="font-medium text-slate-900">{content.timeLimitMinutes ? `${content.timeLimitMinutes} minutes` : 'None'}</dd>
        </div>
      </dl>
    </div>
  );
}
