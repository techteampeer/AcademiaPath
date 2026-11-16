import { createSlots, runIsolated, siblingWorker, transferableCopy } from '../workers/isolated.js';
import { failureReport } from './inspect.js';
import { SCORM_LIMITS } from './limits.js';
import type { ScormInspectionReport } from './report.js';

const WORKER_URL = siblingWorker('inspect-worker', import.meta.url);
const withSlot = createSlots(SCORM_LIMITS.maxConcurrent);

/**
 * AP-033B: inspects a SCORM package in a worker thread with a hard time and memory limit (shared isolation with
 * document extraction). Always returns a report; a package that exceeds the limits gets SCORM_INSPECTION_LIMIT.
 */
export function inspectInWorker(bytes: Uint8Array, options: { fileName?: string | null; timeoutMs?: number } = {}): Promise<ScormInspectionReport> {
  const fileName = options.fileName ?? null;
  return withSlot(async () => {
    const copy = transferableCopy(bytes);
    const result = await runIsolated<ScormInspectionReport>(WORKER_URL, { bytes: copy, fileName }, [copy], {
      timeoutMs: options.timeoutMs ?? SCORM_LIMITS.timeoutMs,
      heapMb: SCORM_LIMITS.workerHeapMb,
    });
    if (result.ok) return result.value;
    return failureReport(bytes, fileName, result.reason === 'crash' ? 'SCORM_INSPECTION_FAILED' : 'SCORM_INSPECTION_LIMIT');
  });
}
