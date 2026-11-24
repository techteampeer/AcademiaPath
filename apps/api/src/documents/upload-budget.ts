import type { ServerResponse } from 'node:http';

const CLOCK_SLACK_MS = 50;

/**
 * AP-SEC-05A: the time budget of one document upload, from the moment its body has arrived.
 *
 * Uploads reach the API through the web app's Next.js proxy, which answers `500` and drops the connection to the API
 * after `API_PROXY_TIMEOUT_SECONDS` without any data from the API (30 s by default; an inactivity timeout, verified
 * against Next.js 16's source and behaviour). Nothing stops the API's own work when that happens: a handler that kept
 * going could store a document the user was told had failed, and a retry would then create a duplicate. So:
 *
 * - every waiting stage (malware scan, waiting for an extraction slot, extraction) ends by `processingDeadline`, which is
 *   `uploadTimeoutMs - uploadReserveMs` after the body arrived; `uploadTimeoutMs` itself stays 5 s below the proxy's;
 * - `signal` aborts at that deadline, or as soon as the client disconnects, so waiting stages stop at once;
 * - storing starts only through `state() === 'ok'`. From then on (`commit()`), the upload completes even if the client
 *   disconnects: an interrupted request never leaves part of a document, and aborting a request never undoes, nor is
 *   claimed to undo, work that was committed. A retry of such an upload returns the stored document (routes/documents.ts).
 */
export class UploadBudget {
  /** The upload's response is due by then. */
  readonly deadline: number;
  /** Waiting stages end by then, so storing still fits before `deadline`. */
  readonly processingDeadline: number;
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private gone = false;
  private committed = false;

  constructor(timeoutMs: number, reserveMs: number, response: ServerResponse) {
    const now = Date.now();
    this.deadline = now + timeoutMs;
    this.processingDeadline = this.deadline - reserveMs;
    this.signal = this.controller.signal;
    // A response that closes before it was completely sent means the client (or the proxy) went away.
    response.once('close', () => {
      if (response.writableFinished) return;
      this.gone = true;
      if (!this.committed) this.controller.abort(new Error('client_gone'));
    });
    this.timer = setTimeout(() => this.controller.abort(new Error('timeout')), Math.max(0, this.processingDeadline - now));
    this.timer.unref();
  }

  /** Until when a stage with its own limit of `stageMs` may run: its limit, or the budget, whichever ends first. */
  stageDeadline(stageMs: number): number {
    return Math.min(Date.now() + stageMs, this.processingDeadline);
  }

  /** The same, as a duration (at least 1 ms). */
  stageTimeout(stageMs: number): number {
    return Math.max(1, this.stageDeadline(stageMs) - Date.now());
  }

  /**
   * Whether storing may still start: the client is connected and the budget leaves room for it. Timers run on a
   * monotonic clock and can fire a millisecond before `Date.now()` reaches the deadline they were set for (a stage
   * whose own limit was the rest of the budget), so the last `CLOCK_SLACK_MS` already count as exhausted.
   */
  state(): 'ok' | 'client_gone' | 'timeout' {
    if (this.gone) return 'client_gone';
    if (Date.now() >= this.processingDeadline - CLOCK_SLACK_MS) return 'timeout';
    return 'ok';
  }

  /** The client disconnected (at any time, including after `commit()`). */
  get clientGone(): boolean {
    return this.gone;
  }

  /** The point of no return: storing starts, and completes whatever happens to the client. */
  commit(): void {
    this.committed = true;
    clearTimeout(this.timer);
  }
}
