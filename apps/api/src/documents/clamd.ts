import { createConnection } from 'node:net';
import type { MalwareScanner, MalwareScanResult, ScanFailureReason, ScanOptions } from './scanner.js';
import { assessSignatures, SIGNATURE_CHECK_TTL_MS, type SignatureFreshness, type SignatureObservation, type SignaturePolicy } from './signature-freshness.js';

/**
 * AP-040E: malware scanning with a ClamAV daemon (clamd), over its documented socket protocol.
 *
 * Each scan opens one connection to clamd and sends `zINSTREAM`, then the whole file in chunks (a 4-byte big-endian
 * length, then the bytes), then a zero-length chunk; clamd answers with one NUL-terminated line:
 * `stream: OK`, `stream: <signature> FOUND`, or `<message> ERROR`. Only the exact `stream: OK` answer, after the whole
 * file was sent, is a clean verdict. Everything else is a failure with a reason, never clean:
 * - the daemon cannot be reached: `unavailable` (`connect_failed`);
 * - no verdict before the deadline (which includes waiting for a scan slot): `timeout`, and the connection is closed;
 * - the connection ends before a complete answer: `error` (`interrupted`);
 * - an answer that is not a known verdict, or is too long: `error` (`invalid_response`);
 * - clamd's own errors: `error` (`scanner_error`), or `file_too_large` when the file exceeds clamd's StreamMaxLength;
 * - `Heuristics.Limits.Exceeded.*` (clamd stopped at a scan limit, with `AlertExceedsMax yes`): `error`
 *   (`limits_exceeded`), because the file was not fully scanned.
 *
 * The file is sent as views of the caller's buffer (no copy), the answer is capped at 1 KiB, files above `maxBytes`
 * are refused without connecting, and at most `maxConcurrent` scans run at once per API instance; the others wait for
 * a slot within their deadline. Nothing is logged here, and no file content or name is ever sent anywhere but clamd.
 *
 * The clamd protocol has no authentication and no encryption, so the daemon must be local: a Unix socket or a loopback
 * address (for example a sidecar container), never a network host (enforced by the configuration).
 *
 * AP-SEC-05B: a clean answer is only a verdict if the signatures clamd has LOADED are fresh enough. clamd's `VERSION`
 * answer carries the build time of the daily signature database in its engine (`ClamAV 1.5.4/27001/Tue Nov 24 15:37:09
 * 2026`, in clamd's local time zone, which must be UTC); see `parseClamdVersion`. With `signatures` set, every scan
 * also checks that time, at the same time as the scan and within the same deadline and abort signal:
 * - an infected answer stays infected, whatever the signatures' age;
 * - a clean answer with `current` or `aging` signatures is clean;
 * - a clean answer with `stale` signatures is `error` (`signatures_stale`), and with signatures whose age is not known
 *   (no answer, `COMMAND UNAVAILABLE`, no date, an unknown form, a date in the future) `error`
 *   (`signatures_unverified`); if the check got no answer in time, `timeout`;
 * - scan failures stay as they are.
 * A successful observation is reused for at most SIGNATURE_CHECK_TTL_MS (its age is recomputed on every use, from the
 * trusted clock); failed checks are not reused. One check at a time per process: concurrent scans share it. A scan that
 * finds clamd unreachable or loses its connection drops the observation, so a restarted clamd is asked again.
 */

export type ClamdEndpoint = { socketPath: string } | { host: string; port: number };

export type ClamdOptions = {
  endpoint: ClamdEndpoint;
  /** Deadline for one scan, from the call until the verdict, including the wait for a scan slot. */
  timeoutMs: number;
  /** Larger files are not sent (`file_too_large`); keep clamd's StreamMaxLength at least this large. */
  maxBytes: number;
  /** Scans in flight at once from this process. */
  maxConcurrent: number;
  /** Bytes per INSTREAM chunk (default 64 KiB). */
  chunkBytes?: number;
  /**
   * AP-SEC-05B: the signature freshness check. `null` checks nothing and is only for protocol tests; the API always
   * sets it when clamd is configured.
   */
  signatures: SignatureCheckOptions | null;
};

export type SignatureCheckOptions = {
  policy: SignaturePolicy;
  /** The trusted clock, UTC epoch ms (default `Date.now`; the API passes its server clock). */
  now?: () => number;
  /** Called once per completed check of the loaded signatures (not once per scan), for rate-limited logging. */
  onCheck?: (freshness: SignatureFreshness) => void;
};

/** What clamd's `VERSION` answer says about the loaded signatures. */
export type ClamdVersion =
  | ({ kind: 'dated' } & SignatureObservation)
  | { kind: 'undated'; engine: string }
  | { kind: 'unavailable' }
  | { kind: 'unsupported' };

export const CLAMD_SCANNER_NAME = 'clamd';
const COMMAND = Buffer.from('zINSTREAM\0', 'latin1');
const VERSION_COMMAND = Buffer.from('zVERSION\0', 'latin1');
/** The longest a shared signature check waits for clamd (each scan waits for it only until its own deadline). */
const VERSION_TIMEOUT_MS = 5_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** `ClamAV <engine>/<daily version>/<ctime date>`; ctime pads the day of the month with a space. */
const DATED_VERSION = /^ClamAV (\d[0-9A-Za-z.+~_-]{0,31})\/([1-9]\d{0,8})\/(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})$/;
const UNDATED_VERSION = /^ClamAV (\d[0-9A-Za-z.+~_-]{0,31})$/;
const END_OF_STREAM = Buffer.alloc(4);
const MAX_REPLY_BYTES = 1024;
const SIGNATURE_NAME = /^[A-Za-z0-9._:/+-]{1,128}$/;

const failure = (status: 'unavailable' | 'timeout' | 'error', reason: ScanFailureReason): MalwareScanResult => ({ status, scanner: CLAMD_SCANNER_NAME, reason });

/** clamd's answer (without its NUL terminator) as a scan result. Anything but an exact known form is not a verdict. */
export function parseClamdReply(reply: string): MalwareScanResult {
  const text = reply.trim();
  if (text === 'stream: OK') return { status: 'clean', scanner: CLAMD_SCANNER_NAME };
  const found = /^stream: (\S+) FOUND$/.exec(text);
  if (found) {
    const signature = found[1]!;
    if (signature.startsWith('Heuristics.Limits.Exceeded')) return failure('error', 'limits_exceeded');
    return { status: 'infected', scanner: CLAMD_SCANNER_NAME, signature: SIGNATURE_NAME.test(signature) ? signature : 'unrecognized-signature' };
  }
  if (/^INSTREAM size limit exceeded\. ERROR$/.test(text)) return failure('error', 'file_too_large');
  if (/^\S.* ERROR$/.test(text)) return failure('error', 'scanner_error');
  return failure('error', 'invalid_response');
}

/**
 * clamd's `VERSION` answer (without its NUL terminator). Observed with clamd 1.5.4: `ClamAV 1.5.4/27001/Tue Nov 24
 * 15:37:09 2026` when a daily database is loaded (its version and build time, from the engine in memory), `ClamAV
 * 1.5.4` without one, and `COMMAND UNAVAILABLE` with `EnableVersionCommand no`. The date has no time zone: clamd prints
 * it in its own local time, which must be UTC (the official image's default). Only these exact forms are understood,
 * and an impossible date (31 Feb, a wrong weekday) is `unsupported`.
 */
export function parseClamdVersion(reply: string): ClamdVersion {
  const text = reply.trim();
  if (text === 'COMMAND UNAVAILABLE') return { kind: 'unavailable' };
  const undated = UNDATED_VERSION.exec(text);
  if (undated) return { kind: 'undated', engine: undated[1]! };
  const dated = DATED_VERSION.exec(text);
  if (!dated) return { kind: 'unsupported' };
  const [, engine, version, weekday, month, day, hours, minutes, seconds, year] = dated;
  const [d, h, m, s, y, mo] = [Number(day), Number(hours), Number(minutes), Number(seconds), Number(year), MONTHS.indexOf(month!)];
  const time = Date.UTC(y, mo, d, h, m, s);
  const parsed = new Date(time);
  // Date.UTC rolls impossible values over (31 Feb becomes 3 Mar): the round trip must give back every field.
  if (y < 1970 || h > 23 || m > 59 || s > 59 || parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== mo || parsed.getUTCDate() !== d || WEEKDAYS[parsed.getUTCDay()] !== weekday) {
    return { kind: 'unsupported' };
  }
  return { kind: 'dated', engine: engine!, databaseVersion: Number(version), databaseTime: time };
}

type ExchangeOutcome = { kind: 'reply'; text: string } | { kind: 'unreachable' | 'timeout' | 'interrupted' | 'invalid' };

/** The outcome of one check of the loaded signatures: an observation, or why there is none. */
type SignatureCheck = { kind: 'observed'; observation: SignatureObservation } | { kind: 'unknown'; reason: Extract<SignatureFreshness, { state: 'unknown' }>['reason'] };

export class ClamdScanner implements MalwareScanner {
  readonly name = CLAMD_SCANNER_NAME;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly chunkBytes: number;
  /** AP-SEC-05B: the last successful observation of the loaded signatures, and when (trusted clock) it was asked for. */
  private observed: { observation: SignatureObservation; askedAt: number } | null = null;
  /** The signature check in flight, shared by every scan that needs one meanwhile. */
  private checking: Promise<SignatureCheck> | null = null;
  /** Bumped whenever the observation is dropped, so a check started before cannot store an outdated one. */
  private generation = 0;

  constructor(private readonly options: ClamdOptions) {
    if (!(options.maxConcurrent >= 1) || !(options.timeoutMs >= 1) || !(options.maxBytes >= 1)) throw new Error('Invalid clamd scanner limits');
    this.chunkBytes = options.chunkBytes ?? 64 * 1024;
  }

  /**
   * AP-SEC-05A: the scan also ends at the caller's `deadline` (if earlier than its own) or when `signal` aborts.
   * AP-SEC-05B: with `signatures`, a clean answer also needs fresh enough signatures (see the class comment).
   */
  async scan(bytes: Uint8Array, _file?: unknown, options: ScanOptions = {}): Promise<MalwareScanResult> {
    if (bytes.length > this.options.maxBytes) return failure('error', 'file_too_large');
    const deadline = Math.min(Date.now() + this.options.timeoutMs, options.deadline ?? Number.POSITIVE_INFINITY);
    if (options.signal?.aborted) return failure('timeout', 'deadline');
    const signatures = this.options.signatures ? this.signatureFreshness(this.options.signatures, deadline, options.signal) : null;
    const result = await this.scanStream(bytes, deadline, options.signal);
    // clamd may have restarted (with other signatures): ask again before trusting the observation.
    if (result.status === 'unavailable' || (result.status === 'error' && result.reason === 'interrupted')) this.forgetSignatures();
    // Only a clean answer depends on the signatures: infected stays infected, failures stay failures (at once).
    if (!signatures || result.status !== 'clean') {
      void signatures?.catch(() => undefined);
      return result;
    }
    const freshness = await signatures;
    // No answer in time, whether the caller's deadline or the check's own limit came first: a timeout.
    if (freshness === 'deadline' || (freshness.state === 'unknown' && freshness.reason === 'timeout')) return failure('timeout', 'deadline');
    if (freshness.state === 'current' || freshness.state === 'aging') return result;
    return failure('error', freshness.state === 'stale' ? 'signatures_stale' : 'signatures_unverified');
  }

  /**
   * AP-SEC-05B: asks clamd about its loaded signatures now (ignoring a reused observation) and reports the result to
   * `onCheck`; for the startup log. Never throws; `null` without `signatures`.
   */
  async checkSignatures(timeoutMs = VERSION_TIMEOUT_MS): Promise<SignatureFreshness | null> {
    const settings = this.options.signatures;
    if (!settings) return null;
    this.forgetSignatures();
    const freshness = await this.signatureFreshness(settings, Date.now() + timeoutMs);
    return freshness === 'deadline' ? { state: 'unknown', reason: 'timeout' } : freshness;
  }

  private now(settings: SignatureCheckOptions) {
    return (settings.now ?? Date.now)();
  }

  private forgetSignatures() {
    this.observed = null;
    this.generation += 1;
  }

  /** The signatures' state, from a recent observation or a (shared) check; `deadline` if the caller stopped waiting. */
  private async signatureFreshness(settings: SignatureCheckOptions, deadline: number, signal?: AbortSignal): Promise<SignatureFreshness | 'deadline'> {
    const now = this.now(settings);
    const observed = this.observed;
    // Reused only briefly, and never when the clock went backwards since.
    if (observed && now - observed.askedAt >= 0 && now - observed.askedAt < SIGNATURE_CHECK_TTL_MS) return assessSignatures(observed.observation, now, settings.policy);
    const check = await this.waitFor(this.sharedCheck(settings), deadline, signal);
    if (check === 'deadline') return 'deadline';
    return check.kind === 'observed' ? assessSignatures(check.observation, this.now(settings), settings.policy) : { state: 'unknown', reason: check.reason };
  }

  /** At most one `VERSION` request at a time; it ends on its own within VERSION_TIMEOUT_MS. */
  private sharedCheck(settings: SignatureCheckOptions): Promise<SignatureCheck> {
    if (this.checking) return this.checking;
    const generation = this.generation;
    const askedAt = this.now(settings);
    const check = this.exchange(VERSION_COMMAND, Date.now() + Math.min(VERSION_TIMEOUT_MS, this.options.timeoutMs)).then((outcome): SignatureCheck => {
      if (outcome.kind !== 'reply') return { kind: 'unknown', reason: outcome.kind === 'unreachable' ? 'unreachable' : outcome.kind === 'timeout' ? 'timeout' : outcome.kind === 'interrupted' ? 'interrupted' : 'unsupported_response' };
      const version = parseClamdVersion(outcome.text);
      if (version.kind === 'dated') return { kind: 'observed', observation: { engine: version.engine, databaseVersion: version.databaseVersion, databaseTime: version.databaseTime } };
      return { kind: 'unknown', reason: version.kind === 'unavailable' ? 'version_unavailable' : version.kind === 'undated' ? 'no_signature_date' : 'unsupported_response' };
    });
    this.checking = check;
    void check.then((result) => {
      this.checking = null;
      // Only a dated answer is reused, and only if nothing showed meanwhile that clamd may have changed.
      if (result.kind === 'observed' && generation === this.generation) this.observed = { observation: result.observation, askedAt };
      const freshness: SignatureFreshness = result.kind === 'observed' ? assessSignatures(result.observation, this.now(settings), settings.policy) : { state: 'unknown', reason: result.reason };
      try {
        settings.onCheck?.(freshness);
      } catch {
        // Reporting never affects scanning.
      }
    });
    return check;
  }

  /** `promise`'s value, or `deadline` once the deadline passes or the signal aborts (the promise keeps running). */
  private waitFor<T>(promise: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T | 'deadline'> {
    if (signal?.aborted || Date.now() >= deadline) return Promise.resolve('deadline');
    return new Promise((resolve) => {
      const stop = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        resolve('deadline');
      };
      const timer = setTimeout(stop, Math.max(0, deadline - Date.now()));
      signal?.addEventListener('abort', stop, { once: true });
      void promise.then((value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        resolve(value);
      });
    });
  }

  /** One INSTREAM scan within the deadline, including the wait for a scan slot. */
  private async scanStream(bytes: Uint8Array, deadline: number, signal?: AbortSignal): Promise<MalwareScanResult> {
    if (!(await this.acquire(deadline, signal))) return failure('timeout', 'deadline');
    try {
      // A slot freed just at the deadline is of no use: do not open a connection that cannot finish.
      if (Date.now() >= deadline || signal?.aborted) return failure('timeout', 'deadline');
      return await this.instream(bytes, deadline, signal);
    } finally {
      this.release();
    }
  }

  /** Whether clamd answers `PONG` within the deadline (for readiness checks; never used as a verdict). */
  async ping(timeoutMs = this.options.timeoutMs): Promise<boolean> {
    const reply = await this.exchange(Buffer.from('zPING\0', 'latin1'), Date.now() + timeoutMs);
    return reply.kind === 'reply' && reply.text === 'PONG';
  }

  private acquire(deadline: number, signal?: AbortSignal): Promise<boolean> {
    if (this.active < this.options.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const giveUp = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', giveUp);
        const index = this.waiting.indexOf(grant);
        if (index !== -1) this.waiting.splice(index, 1);
        resolve(false);
      };
      const grant = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', giveUp);
        resolve(true);
      };
      const timer = setTimeout(giveUp, Math.max(0, deadline - Date.now()));
      signal?.addEventListener('abort', giveUp, { once: true });
      this.waiting.push(grant);
    });
  }

  /** Hands the slot to the next waiting scan, or frees it. */
  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }

  private async instream(bytes: Uint8Array, deadline: number, signal?: AbortSignal): Promise<MalwareScanResult> {
    const chunks: Uint8Array[] = [COMMAND];
    for (let offset = 0; offset < bytes.length; offset += this.chunkBytes) {
      const chunk = bytes.subarray(offset, Math.min(offset + this.chunkBytes, bytes.length));
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(chunk.length, 0);
      chunks.push(header, chunk);
    }
    chunks.push(END_OF_STREAM);
    const outcome = await this.exchange(chunks, deadline, signal);
    switch (outcome.kind) {
      case 'reply':
        return parseClamdReply(outcome.text);
      case 'unreachable':
        return failure('unavailable', 'connect_failed');
      case 'timeout':
        return failure('timeout', 'deadline');
      case 'interrupted':
        return failure('error', 'interrupted');
      case 'invalid':
        return failure('error', 'invalid_response');
    }
  }

  /**
   * Sends `request` on a new connection (respecting backpressure) and waits for one NUL-terminated answer. The answer
   * may arrive before everything was sent (clamd answers at once when a stream exceeds its limit, then closes).
   */
  private exchange(request: Uint8Array | Uint8Array[], deadline: number, signal?: AbortSignal): Promise<ExchangeOutcome> {
    const parts = Array.isArray(request) ? request : [request];
    return new Promise((resolve) => {
      const endpoint = this.options.endpoint;
      const socket = 'socketPath' in endpoint ? createConnection({ path: endpoint.socketPath }) : createConnection({ host: endpoint.host, port: endpoint.port });
      let connected = false;
      let settled = false;
      let received = Buffer.alloc(0);
      const finish = (outcome: Parameters<typeof resolve>[0]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        socket.destroy();
        resolve(outcome);
      };
      const timer = setTimeout(() => finish({ kind: 'timeout' }), Math.max(0, deadline - Date.now()));
      // The caller stopped waiting (its time budget ran out or its client went away): close the connection now.
      const onAbort = () => finish({ kind: 'timeout' });
      signal?.addEventListener('abort', onAbort, { once: true });
      const write = (data: Uint8Array) =>
        new Promise<boolean>((done) => {
          if (settled || socket.destroyed) return done(false);
          if (socket.write(data)) return done(true);
          const onDrain = () => (socket.off('close', onClose), done(true));
          const onClose = () => (socket.off('drain', onDrain), done(false));
          socket.once('drain', onDrain);
          socket.once('close', onClose);
        });
      socket.setNoDelay(true);
      socket.on('connect', () => {
        connected = true;
        void (async () => {
          for (const part of parts) if (!(await write(part))) return;
        })();
      });
      socket.on('data', (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        const end = received.indexOf(0);
        if (end !== -1) return finish({ kind: 'reply', text: received.subarray(0, end).toString('latin1') });
        if (received.length > MAX_REPLY_BYTES) finish({ kind: 'invalid' });
      });
      // Before the connection exists the daemon is unreachable; afterwards, an ending without a complete answer is an
      // interruption (an answer without its terminator is not trusted).
      socket.on('error', () => finish(connected ? (received.length ? { kind: 'invalid' } : { kind: 'interrupted' }) : { kind: 'unreachable' }));
      socket.on('close', () => finish(connected ? (received.length ? { kind: 'invalid' } : { kind: 'interrupted' }) : { kind: 'unreachable' }));
    });
  }
}
