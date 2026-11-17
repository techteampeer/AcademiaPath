import { createSlots, runIsolated, siblingWorker, transferableCopy } from '../workers/isolated.js';
import { failureReport } from './inspect.js';
import { CARTRIDGE_LIMITS, type CartridgeInspectionReport } from './report.js';

/** AP-038D: Common Cartridge inspection in a worker thread (30 s, 256 MB heap, at most two at a time, no network). */
const WORKER_URL = siblingWorker('inspect-worker', import.meta.url);
const withSlot = createSlots(CARTRIDGE_LIMITS.maxConcurrent);

export function inspectCartridgeInWorker(bytes: Uint8Array, options: { fileName?: string | null; timeoutMs?: number } = {}): Promise<CartridgeInspectionReport> {
  const fileName = options.fileName ?? null;
  return withSlot(async () => {
    const copy = transferableCopy(bytes);
    const result = await runIsolated<CartridgeInspectionReport>(WORKER_URL, { bytes: copy, fileName }, [copy], {
      timeoutMs: options.timeoutMs ?? CARTRIDGE_LIMITS.timeoutMs,
      heapMb: CARTRIDGE_LIMITS.workerHeapMb,
    });
    if (result.ok) return result.value;
    return failureReport(bytes, fileName, result.reason === 'crash' ? 'CARTRIDGE_INSPECTION_FAILED' : 'CARTRIDGE_INSPECTION_LIMIT');
  });
}
