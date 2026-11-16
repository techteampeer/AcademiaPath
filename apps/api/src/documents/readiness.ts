import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isMountPoint } from './mounts.js';

/**
 * AP-040B: whether document storage can safely be used. Read-only: it looks at the directory's metadata and access
 * rights and at the mount table, and never creates, writes or removes anything.
 *
 * `mountCheck` modes (`DOCUMENT_STORAGE_MOUNT_CHECK`):
 * - `off` (default outside production): no mount check. Local and test storage is an ordinary directory.
 * - `report` (default in production): the directory must exist (uploads are refused otherwise); whether it is
 *   readable, writable and a mount is checked and reported (startup log, administrator readiness endpoint) but does
 *   not stop the API or uploads, because these checks have not yet been verified inside the Cloud Run API service.
 * - `enforce`: the directory must also be a mount point. The API refuses to start, and uploads are refused, when it
 *   is not. Switch to it only after `report` has shown `mounted` in production.
 */
export type StorageMountCheck = 'off' | 'report' | 'enforce';

export type StorageReadiness = {
  /** `ready`: usable (and mounted when enforced); `degraded`: usable, but the mount is not confirmed; `unavailable`: not usable. */
  status: 'ready' | 'degraded' | 'unavailable';
  mountCheck: StorageMountCheck;
  directory: 'present' | 'missing' | 'not_a_directory';
  access: 'read_write' | 'denied' | 'not_checked';
  mount: 'mounted' | 'not_mounted' | 'not_checked';
  checkedAt: string;
};

export type ReadinessDeps = { isMountPoint: (path: string) => Promise<boolean>; now: () => Date };
const defaultDeps: ReadinessDeps = { isMountPoint, now: () => new Date() };

export async function checkStorageReadiness(directory: string, mountCheck: StorageMountCheck, deps: ReadinessDeps = defaultDeps): Promise<StorageReadiness> {
  const result: StorageReadiness = { status: 'unavailable', mountCheck, directory: 'missing', access: 'not_checked', mount: 'not_checked', checkedAt: deps.now().toISOString() };
  if (mountCheck === 'off') {
    // Local development and tests: storage is created on first use.
    return { ...result, status: 'ready', directory: 'present' };
  }
  const info = await stat(directory).catch(() => null);
  if (!info) return result;
  if (!info.isDirectory()) return { ...result, directory: 'not_a_directory' };
  result.directory = 'present';
  result.access = await access(directory, constants.R_OK | constants.W_OK | constants.X_OK).then(
    () => 'read_write' as const,
    () => 'denied' as const,
  );
  if (result.access !== 'read_write') return result;
  result.mount = (await deps.isMountPoint(directory)) ? 'mounted' : 'not_mounted';
  result.status = result.mount === 'mounted' ? 'ready' : mountCheck === 'enforce' ? 'unavailable' : 'degraded';
  return result;
}

/**
 * Whether uploads are accepted. `enforce`: only when storage is ready (usable and mounted). Otherwise only when the
 * directory exists, which `stat` shows reliably. In `report` mode the read/write permission is reported but left to
 * the write itself (a failed write is still refused cleanly, with nothing created): how `access()` answers on the
 * Cloud Storage FUSE mount has not been verified in the API service, and a wrong answer must not stop working uploads.
 */
export const acceptsUploads = (readiness: StorageReadiness) => (readiness.mountCheck === 'enforce' ? readiness.status === 'ready' : readiness.directory === 'present');
