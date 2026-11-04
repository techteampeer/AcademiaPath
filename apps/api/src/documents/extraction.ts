import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { DocumentFormat } from '../db/schema/index.js';
import type { ExtractionOutcome } from './extract.js';
import { EXTRACTION_LIMITS } from './formats.js';

// Same extension as this module: .ts under tsx (tests, dev), .js in the compiled build.
const WORKER_URL = new URL(`./extract-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);

/** At most this many documents are parsed at once; further uploads wait for a free slot. */
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: Array<() => void> = [];

async function acquire() {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

const limitsExceeded = (message: string): ExtractionOutcome => ({ ok: false, code: 'DOCUMENT_LIMITS_EXCEEDED', message });

function runWorker(bytes: Uint8Array, expected: DocumentFormat, timeoutMs: number): Promise<ExtractionOutcome> {
  // The worker receives its own copy (a fresh ArrayBuffer; Buffer#slice would be a view), so the
  // original bytes stay available for storage.
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const copy = view.buffer;
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER_URL, {
      workerData: { bytes: copy, expected },
      transferList: [copy],
      resourceLimits: { maxOldGenerationSizeMb: EXTRACTION_LIMITS.workerHeapMb, maxYoungGenerationSizeMb: 64 },
      stdout: true,
      stderr: true,
    });
    // Parser diagnostics are discarded (they may echo document content).
    worker.stdout.resume();
    worker.stderr.resume();
    const finish = (outcome: ExtractionOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(
      () => finish(limitsExceeded(`Processing the document took longer than ${Math.round(timeoutMs / 1000)} seconds.`)),
      timeoutMs,
    );
    worker.once('message', (outcome: ExtractionOutcome) => finish(outcome));
    worker.once('error', (error: Error & { code?: string }) =>
      finish(
        error.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? limitsExceeded('Processing the document needed more memory than allowed.')
          : { ok: false, code: 'DOCUMENT_MALFORMED', message: 'The document could not be processed.' },
      ),
    );
    worker.once('exit', () => finish({ ok: false, code: 'DOCUMENT_MALFORMED', message: 'The document could not be processed.' }));
  });
}

/** Validates and extracts one document in a worker thread with a hard time and memory limit. */
export async function extractInWorker(bytes: Uint8Array, expected: DocumentFormat, timeoutMs: number): Promise<ExtractionOutcome> {
  await acquire();
  try {
    return await runWorker(bytes, expected, timeoutMs);
  } finally {
    release();
  }
}
