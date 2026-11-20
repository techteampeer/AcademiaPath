'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useLocalizedState } from '@/components/i18n/useLocalizedState';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';

/** Saves a downloaded file under the server's file name, then releases the object URL. */
function saveFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * AP-038A / AP-038C1E: downloads the server-built course content package (JSON) or the course archive (ZIP with the
 * document files). Nothing is assembled in the browser. Shown to content authors and administrators; the API decides
 * who may export.
 */
export function CourseExportButton({ courseId }: { courseId: string }) {
  const { t } = useLocale();
  const { handleUnauthorized } = useSession();
  const [state, setState] = useState<{ status: 'idle' | 'busy' | 'done' } | { status: 'failed'; message: string }>({ status: 'idle' });

  const download = async () => {
    setState({ status: 'busy' });
    try {
      const { blob, fileName } = await api.exportCoursePackage(courseId);
      saveFile(blob, fileName);
      setState({ status: 'done' });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      const tooLarge = isApiError(error) && error.code === 'COURSE_EXPORT_TOO_LARGE';
      setState({ status: 'failed', message: tooLarge ? t.errors.codes.COURSE_EXPORT_TOO_LARGE! : t.courses.exportFailed });
    }
  };

  return (
    <div className="flex basis-full flex-col items-start gap-2" data-course-export>
      <div className="flex flex-wrap gap-2">
        <Button variant="inverse" size="sm" onClick={() => void download()} disabled={state.status === 'busy'}>
          {state.status === 'busy' ? t.courses.exporting : t.courses.exportContent}
        </Button>
        <CourseArchiveButton courseId={courseId} />
      </div>
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

/**
 * AP-038C1E: "Download with documents". One archive at a time (the button is disabled while it is prepared); the
 * request is cancelled if the page is left. Errors are described from the API's problem code and follow EN/ES
 * switches while shown; a response that is not a ZIP is reported as a failure, never saved.
 */
function CourseArchiveButton({ courseId }: { courseId: string }) {
  const { t } = useLocale();
  const { handleUnauthorized } = useSession();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useLocalizedState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const download = async () => {
    if (busy) return;
    setBusy(true);
    setDone(false);
    setFailure(null);
    controller.current = new AbortController();
    try {
      const { blob, fileName } = await api.exportCourseArchive(courseId, controller.current.signal);
      saveFile(blob, fileName);
      setDone(true);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (isApiError(error, 401)) handleUnauthorized();
      setFailure((m, ml) => (isApiError(error, 502) && !error.code ? m.courses.exportArchiveFailed : describeApiError(error, ml)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="inverse" size="sm" onClick={() => void download()} disabled={busy} aria-describedby={failure ? 'course-archive-status' : undefined} data-course-archive-export>
        {busy ? t.courses.exportingArchive : t.courses.exportArchive}
      </Button>
      {done || failure ? (
        <div id="course-archive-status" className="basis-full" data-course-archive-status={failure ? 'error' : 'done'}>
          <Alert tone={failure ? 'error' : 'success'} className="max-w-2xl">
            {failure ?? t.courses.exportArchiveDone}
          </Alert>
        </div>
      ) : null}
    </>
  );
}
