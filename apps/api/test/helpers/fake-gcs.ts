/**
 * AP-OPS-02: a simulated Cloud Storage JSON API for tests, on a loopback port, backed by a local directory: each file is
 * an object of one bucket, its generation derived from the file's modification time (a rewritten file gets a new
 * generation, as in Cloud Storage). This mirrors production, where the API writes through the Cloud Storage FUSE mount
 * and recovery reads the bucket directly. It serves only what recovery uses (object metadata and conditional deletes),
 * can fail on demand, and records every request so tests can prove that nothing is listed, downloaded or sent to
 * another bucket. Synthetic data only; no real Cloud Storage is involved.
 */
import { stat, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';

export type FakeGcsFault = 'forbidden' | 'unauthorized' | 'unavailable' | 'hang' | 'reset' | 'garbage' | 'wrong_name' | 'ignore_delete';
export type FakeGcsRequest = { method: string; bucket: string; name: string | null; query: Record<string, string>; authorized: boolean };

export type FakeGcs = {
  url: string;
  bucket: string;
  requests: FakeGcsRequest[];
  /** Faults by object name, or '*' for every request. */
  faults: Map<string, FakeGcsFault>;
  /** Called after an object was deleted, before the answer is sent. */
  onDelete: ((name: string) => void) | null;
  reset(): void;
  close(): Promise<void>;
};

export const generationOf = async (path: string) => String((await stat(path, { bigint: true })).mtimeNs);

export async function startFakeGcs(options: { bucket: string; dir: string }): Promise<FakeGcs> {
  const sockets = new Set<import('node:net').Socket>();
  const fake: FakeGcs = {
    url: '',
    bucket: options.bucket,
    requests: [],
    faults: new Map(),
    onDelete: null,
    reset() {
      fake.requests = [];
      fake.faults.clear();
      fake.onDelete = null;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = /^\/storage\/v1\/b\/([^/]+)\/o(?:\/([^/]+))?$/.exec(url.pathname);
    const bucket = match ? decodeURIComponent(match[1]!) : '';
    const name = match?.[2] !== undefined ? decodeURIComponent(match[2]) : null;
    const authorized = /^Bearer \S+$/.test(String(req.headers.authorization ?? ''));
    fake.requests.push({ method: req.method ?? '', bucket, name, query: Object.fromEntries(url.searchParams), authorized });
    const fault = (name && fake.faults.get(name)) ?? fake.faults.get('*');
    if (fault === 'hang') return; // never answers
    if (fault === 'reset') return void req.socket.destroy();
    if (!authorized || fault === 'unauthorized') return send(res, 401, { error: { code: 401 } });
    if (fault === 'forbidden') return send(res, 403, { error: { code: 403 } });
    if (fault === 'unavailable') return send(res, 503, { error: { code: 503 } });
    // Only single-object metadata reads and deletes exist here: listing or anything else is refused.
    if (!match || name === null || url.searchParams.get('alt') === 'media') return send(res, 400, { error: { code: 400, message: 'not supported by the simulator' } });
    if (bucket !== fake.bucket) return send(res, 404, { error: { code: 404, message: 'The specified bucket does not exist.' } });
    if (name.includes('/') || name.includes('..')) return send(res, 404, { error: { code: 404 } });
    const path = join(options.dir, name);
    const generation = await generationOf(path).catch(() => null);
    if (req.method === 'GET') {
      if (generation === null) return send(res, 404, { error: { code: 404 } });
      if (fault === 'garbage') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end('not json');
      }
      const size = (await stat(path)).size;
      return send(res, 200, { bucket: fake.bucket, name: fault === 'wrong_name' ? `${name}x` : name, generation, size: String(size) });
    }
    if (req.method === 'DELETE') {
      if (generation === null) return send(res, 404, { error: { code: 404 } });
      const wanted = url.searchParams.get('ifGenerationMatch');
      if (wanted !== null && wanted !== generation) return send(res, 412, { error: { code: 412 } });
      if (fault !== 'ignore_delete') await unlink(path);
      fake.onDelete?.(name);
      res.writeHead(204);
      return void res.end();
    }
    send(res, 405, { error: { code: 405 } });
  };
  const server = createServer((req, res) => void handle(req, res).catch(() => send(res, 500, { error: { code: 500 } })));
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  fake.url = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`;
  return fake;
}
