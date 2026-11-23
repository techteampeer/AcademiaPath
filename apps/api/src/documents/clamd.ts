import { createConnection } from 'node:net';
import type { MalwareScanner, MalwareScanResult, ScanFailureReason } from './scanner.js';

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
};

export const CLAMD_SCANNER_NAME = 'clamd';
const COMMAND = Buffer.from('zINSTREAM\0', 'latin1');
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

export class ClamdScanner implements MalwareScanner {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly chunkBytes: number;

  constructor(private readonly options: ClamdOptions) {
    if (!(options.maxConcurrent >= 1) || !(options.timeoutMs >= 1) || !(options.maxBytes >= 1)) throw new Error('Invalid clamd scanner limits');
    this.chunkBytes = options.chunkBytes ?? 64 * 1024;
  }

  async scan(bytes: Uint8Array): Promise<MalwareScanResult> {
    if (bytes.length > this.options.maxBytes) return failure('error', 'file_too_large');
    const deadline = Date.now() + this.options.timeoutMs;
    if (!(await this.acquire(deadline))) return failure('timeout', 'deadline');
    try {
      // A slot freed just at the deadline is of no use: do not open a connection that cannot finish.
      if (Date.now() >= deadline) return failure('timeout', 'deadline');
      return await this.instream(bytes, deadline);
    } finally {
      this.release();
    }
  }

  /** Whether clamd answers `PONG` within the deadline (for readiness checks; never used as a verdict). */
  async ping(timeoutMs = this.options.timeoutMs): Promise<boolean> {
    const reply = await this.exchange(Buffer.from('zPING\0', 'latin1'), Date.now() + timeoutMs);
    return reply.kind === 'reply' && reply.text === 'PONG';
  }

  private acquire(deadline: number): Promise<boolean> {
    if (this.active < this.options.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(
        () => {
          const index = this.waiting.indexOf(grant);
          if (index !== -1) this.waiting.splice(index, 1);
          resolve(false);
        },
        Math.max(0, deadline - Date.now()),
      );
      this.waiting.push(grant);
    });
  }

  /** Hands the slot to the next waiting scan, or frees it. */
  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }

  private async instream(bytes: Uint8Array, deadline: number): Promise<MalwareScanResult> {
    const chunks: Uint8Array[] = [COMMAND];
    for (let offset = 0; offset < bytes.length; offset += this.chunkBytes) {
      const chunk = bytes.subarray(offset, Math.min(offset + this.chunkBytes, bytes.length));
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(chunk.length, 0);
      chunks.push(header, chunk);
    }
    chunks.push(END_OF_STREAM);
    const outcome = await this.exchange(chunks, deadline);
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
  private exchange(request: Uint8Array | Uint8Array[], deadline: number): Promise<{ kind: 'reply'; text: string } | { kind: 'unreachable' | 'timeout' | 'interrupted' | 'invalid' }> {
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
        socket.destroy();
        resolve(outcome);
      };
      const timer = setTimeout(() => finish({ kind: 'timeout' }), Math.max(0, deadline - Date.now()));
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
