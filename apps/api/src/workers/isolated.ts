import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

/**
 * Runs one untrusted-input task in a worker thread with a hard time limit and heap limit, shared by document
 * extraction and SCORM package inspection. The worker is always terminated when the task ends, times out or fails.
 */
export type IsolatedResult<T> = { ok: true; value: T } | { ok: false; reason: 'timeout' | 'memory' | 'crash' };

/** A worker module next to `base` (the caller's import.meta.url): .ts under tsx (tests, dev), .js in the build. */
export const siblingWorker = (name: string, base: string) => new URL(`./${name}${extname(fileURLToPath(base))}`, base);

/** A copy of the bytes in a fresh ArrayBuffer that can be transferred to the worker; the caller keeps its own. */
export function transferableCopy(bytes: Uint8Array): ArrayBuffer {
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  return view.buffer;
}

export function runIsolated<T>(url: URL, workerData: Record<string, unknown>, transferList: ArrayBuffer[], limits: { timeoutMs: number; heapMb: number }): Promise<IsolatedResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(url, {
      workerData,
      transferList,
      resourceLimits: { maxOldGenerationSizeMb: limits.heapMb, maxYoungGenerationSizeMb: 64 },
      stdout: true,
      stderr: true,
    });
    // Diagnostics are discarded (they may echo untrusted content).
    worker.stdout.resume();
    worker.stderr.resume();
    const finish = (result: IsolatedResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), limits.timeoutMs);
    worker.once('message', (value: T) => finish({ ok: true, value }));
    worker.once('error', (error: Error & { code?: string }) => finish({ ok: false, reason: error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'crash' }));
    worker.once('exit', () => finish({ ok: false, reason: 'crash' }));
  });
}

/** At most `max` tasks run at once; further callers wait for a free slot. */
export function createSlots(max: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async function withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (running < max) running += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}
