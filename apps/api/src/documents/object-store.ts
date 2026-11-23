import { isStorageKey } from './storage.js';

/**
 * AP-OPS-02: a minimal client for the Cloud Storage JSON API, used ONLY by approval-based storage recovery (never by
 * the application, which keeps writing through the Cloud Storage FUSE mount). It reads object metadata and deletes an
 * exact object generation, directly against Cloud Storage, which is strongly consistent; nothing is cached.
 *
 * - Only `objects.get` for metadata (`fields=bucket,name,generation,size`; never `alt=media`, so no document content is
 *   ever downloaded) and `objects.delete` with `ifGenerationMatch` are used. Objects are never listed.
 * - The bucket is fixed when the store is created, and object names must be storage keys (random UUID v4 names, with
 *   an optional fixed prefix): nothing outside that namespace can be read or deleted.
 * - Only HTTP 200 means present and only HTTP 404 means missing. Permission errors, timeouts, unreachable or failing
 *   servers, precondition failures and unexpected answers are distinct errors, never "missing".
 * - Nothing is logged here, and errors carry a kind and an HTTP status only, never a key or a URL.
 *
 * It uses the JSON API over `fetch` (Node 22), with an access token from an injected provider (on Cloud Run: the
 * metadata server, see `metadataServerToken`), instead of the much larger official client library: two documented
 * requests are all recovery needs. Tests point it at a local simulated API.
 */

export type ObjectStoreErrorKind = 'not_found' | 'permission_denied' | 'timeout' | 'unavailable' | 'precondition_failed' | 'invalid_key' | 'error';

export class ObjectStoreError extends Error {
  /** A plain code for journals and audit records (for example PERMISSION_DENIED). */
  readonly code: string;
  constructor(
    readonly kind: ObjectStoreErrorKind,
    readonly status: number | null = null,
  ) {
    super(`Cloud Storage request failed: ${kind}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'ObjectStoreError';
    this.code = kind.toUpperCase();
  }
}

export type ObjectObservation = { state: 'present'; generation: string; size: number } | { state: 'missing' };

/** What recovery needs from object storage: exact observation and a generation-conditioned deletion. */
export interface RecoveryObjectStore {
  /** The bucket every request goes to (bound into recovery approvals). */
  readonly bucket: string;
  /** A description of the API endpoint, without credentials (bound into recovery approvals). */
  readonly endpoint: string;
  stat(key: string): Promise<ObjectObservation>;
  /** Deletes exactly this generation. `already_gone` when no such object exists; throws `precondition_failed` when it changed. */
  deleteGeneration(key: string, generation: string): Promise<'deleted' | 'already_gone'>;
}

export type GcsJsonStoreOptions = {
  bucket: string;
  /** Default https://storage.googleapis.com. Tests use a local simulated API. */
  baseUrl?: string;
  /** A fixed object-name prefix before the storage key (default none: the FUSE mount stores files at the bucket root). */
  prefix?: string;
  getAccessToken: () => Promise<string>;
  /** Per request (default 10 s). */
  timeoutMs?: number;
  fetch?: typeof fetch;
};

// Bucket names: 3-63 lowercase letters, digits, dashes, underscores and dots (no dotted names over 63 here).
const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const PREFIX = /^(?:[a-z0-9][a-z0-9._-]*\/)?$/;

export class GcsJsonObjectStore implements RecoveryObjectStore {
  readonly bucket: string;
  readonly endpoint: string;
  private readonly prefix: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: GcsJsonStoreOptions) {
    if (!BUCKET_NAME.test(options.bucket)) throw new Error('Invalid bucket name');
    const prefix = options.prefix ?? '';
    if (!PREFIX.test(prefix)) throw new Error('Invalid object prefix');
    const base = new URL(options.baseUrl ?? 'https://storage.googleapis.com');
    if (base.username || base.password || base.search || base.hash || (base.pathname !== '/' && base.pathname !== '')) throw new Error('Invalid storage API URL');
    this.bucket = options.bucket;
    this.prefix = prefix;
    this.endpoint = base.origin;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetcher = options.fetch ?? fetch;
  }

  /** The object's URL, only for a storage key inside the configured namespace. */
  private objectUrl(key: string, query: Record<string, string>): string {
    if (!isStorageKey(key)) throw new ObjectStoreError('invalid_key');
    const url = new URL(`/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(`${this.prefix}${key}`)}`, this.endpoint);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url.toString();
  }

  private async request(method: 'GET' | 'DELETE', url: string): Promise<Response> {
    let token: string;
    try {
      token = await this.options.getAccessToken();
    } catch {
      throw new ObjectStoreError('permission_denied');
    }
    try {
      return await this.fetcher(url, { method, headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
      throw new ObjectStoreError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable');
    }
  }

  private static failure(status: number): ObjectStoreError {
    if (status === 401 || status === 403) return new ObjectStoreError('permission_denied', status);
    if (status === 404) return new ObjectStoreError('not_found', status);
    if (status === 412) return new ObjectStoreError('precondition_failed', status);
    if (status === 408 || status === 429 || status >= 500) return new ObjectStoreError(status === 408 ? 'timeout' : 'unavailable', status);
    return new ObjectStoreError('error', status);
  }

  async stat(key: string): Promise<ObjectObservation> {
    const res = await this.request('GET', this.objectUrl(key, { fields: 'bucket,name,generation,size' }));
    if (res.status === 404) {
      await res.body?.cancel();
      return { state: 'missing' };
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      throw GcsJsonObjectStore.failure(res.status);
    }
    let body: { bucket?: unknown; name?: unknown; generation?: unknown; size?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new ObjectStoreError('error', res.status);
    }
    // The answer must describe exactly the object that was asked for.
    if (body.bucket !== this.bucket || body.name !== `${this.prefix}${key}` || typeof body.generation !== 'string' || !/^[1-9]\d{0,19}$/.test(body.generation)) {
      throw new ObjectStoreError('error', res.status);
    }
    return { state: 'present', generation: body.generation, size: Number(body.size ?? 0) };
  }

  async deleteGeneration(key: string, generation: string): Promise<'deleted' | 'already_gone'> {
    if (!/^[1-9]\d{0,19}$/.test(generation)) throw new ObjectStoreError('precondition_failed');
    const res = await this.request('DELETE', this.objectUrl(key, { ifGenerationMatch: generation }));
    await res.body?.cancel();
    if (res.status === 204 || res.status === 200) return 'deleted';
    if (res.status === 404) return 'already_gone';
    throw GcsJsonObjectStore.failure(res.status);
  }
}

/**
 * An access token for the Cloud Run service identity, from the metadata server (no key file, no library). Not used by
 * anything yet: production recovery is disabled (see scripts/storage-recover-approved.ts).
 */
export function metadataServerToken(options: { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): () => Promise<string> {
  const url = new URL('/computeMetadata/v1/instance/service-accounts/default/token', options.baseUrl ?? 'http://metadata.google.internal').toString();
  const fetcher = options.fetch ?? fetch;
  return async () => {
    const res = await fetcher(url, { headers: { 'metadata-flavor': 'Google' }, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 5_000) });
    if (res.status !== 200) throw new Error('No access token from the metadata server');
    const body = (await res.json()) as { access_token?: unknown };
    if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('No access token from the metadata server');
    return body.access_token;
  };
}
