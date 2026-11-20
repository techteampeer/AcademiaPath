import { withPackageSlot } from '../scorm/inspection.js';
import { runIsolated, siblingWorker, transferableCopy } from '../workers/isolated.js';
import { failedValidationReport, type ArchiveValidationReport } from './archive-validation.js';

/**
 * AP-038C2C: course archive validation in a worker thread, with the same limits as the SCORM and Common Cartridge
 * inspections (30 s, 256 MB heap, no network). It runs in their shared pool (`withPackageSlot`), so at most two
 * package jobs of any kind run at once per API instance: archive previews add no worker capacity of their own.
 */
export const ARCHIVE_PREVIEW_LIMITS = { timeoutMs: 30_000, workerHeapMb: 256 } as const;

const WORKER_URL = siblingWorker('archive-validation-worker', import.meta.url);

/** `workerUrl` exists for tests (a worker that fails); the API always uses the validation worker. */
export function validateCourseArchiveInWorker(bytes: Uint8Array, options: { timeoutMs?: number; workerUrl?: URL } = {}): Promise<ArchiveValidationReport> {
  return withPackageSlot(async () => {
    const copy = transferableCopy(bytes);
    const result = await runIsolated<ArchiveValidationReport>(options.workerUrl ?? WORKER_URL, { bytes: copy }, [copy], {
      timeoutMs: options.timeoutMs ?? ARCHIVE_PREVIEW_LIMITS.timeoutMs,
      heapMb: ARCHIVE_PREVIEW_LIMITS.workerHeapMb,
    });
    if (result.ok) return result.value;
    return failedValidationReport(bytes.byteLength, result.reason === 'crash' ? 'ARCHIVE_VALIDATION_FAILED' : 'ARCHIVE_VALIDATION_LIMIT');
  });
}
