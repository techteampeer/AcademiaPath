'use client';

import { useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useSession } from '@/components/session/SessionProvider';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';

/**
 * AP-038A: downloads the server-built course content package (never assembled in the browser). Shown to content
 * authors and administrators; the API decides who may export.
 */
export function CourseExportButton({ courseId }: { courseId: string }) {
  const { t } = useLocale();
  const { handleUnauthorized } = useSession();
  const [state, setState] = useState<{ status: 'idle' | 'busy' | 'done' } | { status: 'failed'; message: string }>({ status: 'idle' });

  const download = async () => {
    setState({ status: 'busy' });
    try {
      const { blob, fileName } = await api.exportCoursePackage(courseId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setState({ status: 'done' });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      const tooLarge = isApiError(error) && error.code === 'COURSE_EXPORT_TOO_LARGE';
      setState({ status: 'failed', message: tooLarge ? t.errors.codes.COURSE_EXPORT_TOO_LARGE! : t.courses.exportFailed });
    }
  };

  return (
    <div className="flex basis-full flex-col items-start gap-2" data-course-export>
      <Button variant="inverse" size="sm" onClick={() => void download()} disabled={state.status === 'busy'}>
        {state.status === 'busy' ? t.courses.exporting : t.courses.exportContent}
      </Button>
      {state.status === 'done' ? (
        <Alert tone="success" className="max-w-2xl">
          {t.courses.exportDone}
        </Alert>
      ) : null}
      {state.status === 'failed' ? (
        <Alert tone="error" className="max-w-2xl">
          {state.message}
        </Alert>
      ) : null}
    </div>
  );
}
