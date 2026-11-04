import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const STORAGE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Where original uploaded files live. Implementations must never derive paths from user input. */
export interface DocumentStorage {
  put(bytes: Uint8Array): Promise<string>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

/**
 * Private local directory (outside the repository and every public web directory, see config).
 * Files get server-generated opaque names (random UUIDs, no extension) and owner-only permissions.
 * Keys are validated, so a stored key can never point outside the directory (no path traversal).
 */
export class LocalDocumentStorage implements DocumentStorage {
  readonly root: string;
  private ready: Promise<unknown> | null = null;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    if (!STORAGE_KEY.test(key)) throw new Error('Invalid document storage key');
    const path = join(this.root, key);
    if (dirname(path) !== this.root) throw new Error('Invalid document storage key');
    return path;
  }

  async put(bytes: Uint8Array): Promise<string> {
    this.ready ??= mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.ready;
    const key = randomUUID();
    // `wx`: never overwrite an existing file.
    await writeFile(this.pathFor(key), bytes, { flag: 'wx', mode: 0o600 });
    return key;
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
