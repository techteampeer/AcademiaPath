/**
 * AP-040E: a synthetic ClamAV daemon for tests. It speaks clamd's socket protocol (`zINSTREAM`, `zPING`, and since
 * AP-SEC-05B `zVERSION`) on a loopback port or a Unix socket, and can misbehave on purpose: hang, cut the connection,
 * answer with garbage, errors or an unterminated answer. It "detects" only the plain-text part of the EICAR antivirus
 * test string (a harmless, standard test marker), and records what it received so tests can prove the whole file was
 * sent. No real malware is involved.
 */
import { createHash } from 'node:crypto';
import { createServer, type Socket } from 'node:net';

/** The plain-text part of the EICAR test string (the test PDF writer escapes the string's punctuation). */
export const EICAR_MARKER_TEXT = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';
export const FAKE_SIGNATURE = 'Eicar-Test-Signature';

export type FakeClamdBehaviour =
  /** Scan normally: FOUND for the EICAR marker, OK otherwise. */
  | 'scan'
  /** Never answer. */
  | 'hang'
  /** Close the connection after the first chunk arrives. */
  | 'close_mid_stream'
  /** Close the connection after the whole stream, without an answer. */
  | 'close_before_reply'
  /** Send `stream: O`, then close (an answer without its terminator). */
  | 'partial_reply'
  /** Send 2 KiB without a terminator. */
  | 'long_reply'
  /** Answer with exactly this text (a NUL terminator is added). */
  | { reply: string };

/**
 * AP-SEC-05B: what `zVERSION` answers. A function is called for each request (the default reports a daily database
 * built an hour before the real current time, so tests that do not care about signatures see current ones); a string
 * is answered as it is; `hang` never answers; `close` closes the connection without an answer.
 */
export type FakeClamdVersion = string | (() => string) | 'hang' | 'close';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (value: number) => String(value).padStart(2, '0');

/**
 * clamd's VERSION answer for a daily database built at `builtAt`, as clamd 1.5.4 prints it in UTC (the C `ctime`
 * format: the day of the month padded with a space), for example `ClamAV 1.5.4/27001/Tue Nov  3 05:07:09 2026`.
 */
export function clamdVersionReply(builtAt: Date | number, databaseVersion = 27001, engine = '1.5.4'): string {
  const t = new Date(builtAt);
  const date = `${WEEKDAYS[t.getUTCDay()]} ${MONTHS[t.getUTCMonth()]} ${String(t.getUTCDate()).padStart(2, ' ')} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())} ${t.getUTCFullYear()}`;
  return `ClamAV ${engine}/${databaseVersion}/${date}`;
}

const currentVersion = () => clamdVersionReply(Date.now() - 60 * 60_000);

export type FakeClamd = {
  port: number;
  socketPath: string | null;
  /** What the next scans do (a function receives the 1-based scan number). PING is always answered. */
  behaviour: FakeClamdBehaviour | ((scan: number) => FakeClamdBehaviour);
  /** Delay before answering a completed stream (ms). */
  delayMs: number;
  /** Connections of any kind (including PING). */
  connections: number;
  /** INSTREAM scans started, in flight now, and the most in flight at once. */
  scans: number;
  active: number;
  maxActive: number;
  /** Every completed stream: its size and SHA-256. */
  streams: Array<{ bytes: number; sha256: string }>;
  /** AP-SEC-05B: the `zVERSION` answer, how long to wait before it (ms), and how many were asked for. */
  version: FakeClamdVersion;
  versionDelayMs: number;
  versionRequests: number;
  /** Connections closed by the client before an answer was sent. */
  abandoned: number;
  reset(): void;
  close(): Promise<void>;
};

export async function startFakeClamd(options: { socketPath?: string } = {}): Promise<FakeClamd> {
  const sockets = new Set<Socket>();
  const fake: FakeClamd = {
    port: 0,
    socketPath: options.socketPath ?? null,
    behaviour: 'scan',
    delayMs: 0,
    connections: 0,
    scans: 0,
    active: 0,
    maxActive: 0,
    streams: [],
    abandoned: 0,
    version: currentVersion,
    versionDelayMs: 0,
    versionRequests: 0,
    reset() {
      Object.assign(fake, { behaviour: 'scan', delayMs: 0, connections: 0, scans: 0, active: 0, maxActive: 0, streams: [], abandoned: 0, version: currentVersion, versionDelayMs: 0, versionRequests: 0 });
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    fake.connections += 1;
    let behaviour: FakeClamdBehaviour = 'scan';
    let scanning = false;
    let buffer = Buffer.alloc(0);
    let command: string | null = null;
    const data: Buffer[] = [];
    let chunks = 0;
    let answered = false;
    let done = false;
    socket.on('close', () => {
      sockets.delete(socket);
      if (!scanning) return;
      fake.active -= 1;
      if (!answered) fake.abandoned += 1;
    });
    socket.on('error', () => undefined);
    const answer = (text: string | Buffer, end = true) => {
      answered = true;
      socket.write(typeof text === 'string' ? Buffer.from(text, 'latin1') : text);
      if (end) socket.end();
    };
    const finishStream = () => {
      done = true;
      const bytes = Buffer.concat(data);
      fake.streams.push({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      const reply = () => {
        if (socket.destroyed) return;
        if (behaviour === 'hang') return;
        if (behaviour === 'close_before_reply') return void socket.destroy();
        if (behaviour === 'partial_reply') return answer('stream: O');
        if (behaviour === 'long_reply') return answer('A'.repeat(2048), false);
        if (typeof behaviour === 'object') return answer(`${behaviour.reply}\0`);
        answer(bytes.includes(EICAR_MARKER_TEXT) ? `stream: ${FAKE_SIGNATURE} FOUND\0` : 'stream: OK\0');
      };
      if (fake.delayMs) setTimeout(reply, fake.delayMs);
      else reply();
    };
    socket.on('data', (chunk: Buffer) => {
      if (done) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (command === null) {
        const end = buffer.indexOf(0);
        if (end === -1) return;
        command = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 1);
        if (command === 'zPING') return answer('PONG\0');
        if (command === 'zVERSION') {
          fake.versionRequests += 1;
          const version = fake.version;
          const reply = () => {
            if (socket.destroyed || version === 'hang') return;
            if (version === 'close') return void socket.destroy();
            answer(`${typeof version === 'function' ? version() : version}\0`);
          };
          if (fake.versionDelayMs) setTimeout(reply, fake.versionDelayMs);
          else reply();
          return;
        }
        if (command !== 'zINSTREAM') return answer('UNKNOWN COMMAND\0');
        scanning = true;
        fake.scans += 1;
        fake.active += 1;
        fake.maxActive = Math.max(fake.maxActive, fake.active);
        behaviour = typeof fake.behaviour === 'function' ? fake.behaviour(fake.scans) : fake.behaviour;
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          buffer = buffer.subarray(4);
          return finishStream();
        }
        if (buffer.length < 4 + length) return;
        data.push(Buffer.from(buffer.subarray(4, 4 + length)));
        buffer = buffer.subarray(4 + length);
        chunks += 1;
        if (behaviour === 'close_mid_stream' && chunks === 1) {
          done = true;
          return void socket.destroy();
        }
      }
    });
  });
  await new Promise<void>((resolve) => (options.socketPath ? server.listen(options.socketPath, resolve) : server.listen(0, '127.0.0.1', resolve)));
  const address = server.address();
  if (address && typeof address === 'object') fake.port = address.port;
  return fake;
}
