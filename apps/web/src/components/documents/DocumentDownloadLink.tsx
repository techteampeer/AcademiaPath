'use client';

import { useState, type MouseEvent, type ReactNode } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useSession } from '@/components/session/SessionProvider';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';

/**
 * AP-040B: the original-file download. Still an ordinary download link (it works without script, and
 * modified clicks keep the browser's behaviour), but a plain click fetches the file first, so a missing or
 * corrupt stored file, or unavailable storage, is explained in the interface language instead of the browser
 * saving an error response as the document. The API checks access and verifies the file; nothing is decided here.
 */
export function DocumentDownloadLink({ courseId, activityId, className, children }: { courseId: string; activityId: string; className?: string; children: ReactNode }) {
  const { t } = useLocale();
  const { handleUnauthorized } = useSession();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const onClick = async (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const { blob, fileName } = await api.downloadDocumentFile(courseId, activityId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      const known = isApiError(error) && error.code ? t.errors.codes[error.code] : undefined;
      setMessage(known ?? t.documents.panel.downloadFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <a href={api.documentFileHref(courseId, activityId)} download className={className} onClick={(event) => void onClick(event)} aria-busy={busy}>
        {children}
      </a>
      {message ? (
        <p role="alert" className="basis-full text-sm text-red-700" data-download-error>
          {message}
        </p>
      ) : null}
    </>
  );
}
