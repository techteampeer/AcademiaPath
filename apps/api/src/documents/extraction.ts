import type { DocumentFormat } from '../db/schema/index.js';
import { createSlots, runIsolated, siblingWorker, SlotWaitAborted, transferableCopy } from '../workers/isolated.js';
import type { ExtractionOutcome } from './extract.js';
import { EXTRACTION_LIMITS } from './formats.js';

const WORKER_URL = siblingWorker('extract-worker', import.meta.url);

/** At most this many documents are parsed at once; further uploads wait for a free slot. */
const withSlot = createSlots(2);

const limitsExceeded = (message: string): ExtractionOutcome => ({ ok: false, code: 'DOCUMENT_LIMITS_EXCEEDED', message });

/** The caller gave up on the extraction (AP-SEC-05A): its upload's time budget ran out or its client went away. */
export class ExtractionAborted extends Error {
  constructor() {
    super('Extraction abandoned by the caller');
    this.name = 'ExtractionAborted';
  }
}

async function runWorker(bytes: Uint8Array, expected: DocumentFormat, timeoutMs: number, signal?: AbortSignal): Promise<ExtractionOutcome> {
  // The worker receives its own copy, so the original bytes stay available for storage.
  const copy = transferableCopy(bytes);
  const result = await runIsolated<ExtractionOutcome>(WORKER_URL, { bytes: copy, expected }, [copy], { timeoutMs, heapMb: EXTRACTION_LIMITS.workerHeapMb }, signal);
  if (result.ok) return result.value;
  if (result.reason === 'aborted') throw new ExtractionAborted();
  if (result.reason === 'timeout') return limitsExceeded(`Processing the document took longer than ${Math.round(timeoutMs / 1000)} seconds.`);
  if (result.reason === 'memory') return limitsExceeded('Processing the document needed more memory than allowed.');
  return { ok: false, code: 'DOCUMENT_MALFORMED', message: 'The document could not be processed.' };
}

/**
 * Validates and extracts one document in a worker thread with a hard time and memory limit. AP-SEC-05A: when `signal`
 * aborts, a waiting extraction leaves the queue and a running one is terminated; `ExtractionAborted` is thrown.
 */
export async function extractInWorker(bytes: Uint8Array, expected: DocumentFormat, timeoutMs: number, signal?: AbortSignal): Promise<ExtractionOutcome> {
  try {
    return await withSlot(() => runWorker(bytes, expected, timeoutMs, signal), signal);
  } catch (error) {
    if (error instanceof SlotWaitAborted) throw new ExtractionAborted();
    throw error;
  }
}
