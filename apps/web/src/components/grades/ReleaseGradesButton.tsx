'use client';

import { useLocale } from '@/components/i18n/LocaleProvider';
import { useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api/endpoints';

/**
 * Releases the current grades of one quiz or assignment. The server copies each graded student's
 * current grade into the version students can see; answer keys are never released.
 */
export function ReleaseGradesButton({ courseId, activityId, label, onReleased }: { courseId: string; activityId: string; label: string; onReleased?: () => void }) {
  const { run, pending, result } = useCsrfAction();
  const { t } = useLocale();
  const r = t.assignments.release;
  const release = async () => {
    const released = await run(
      (csrf) => api.releaseGrades(courseId, activityId, csrf),
      (value) => (value.releasedCount === 0 ? r.nothing : r.released(value.releasedCount)),
    );
    if (released) onReleased?.();
  };
  return (
    <div className="space-y-2">
      <Button size="sm" onClick={() => void release()} disabled={pending}>
        {pending ? r.releasing : label}
      </Button>
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
    </div>
  );
}
