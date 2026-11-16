import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/** `/proc/mounts` escapes spaces, tabs, newlines and backslashes in paths as octal (`\040`…). */
const unescapeMountPath = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));

/**
 * Whether `path` is a mount point: listed as a mount target in `/proc/mounts`, or a directory on another device than
 * its parent. This is the check the cloud demo seed job has used since AP-025 to refuse running without the documents
 * bucket mounted at /mnt/documents (it passed in that Cloud Run job, which mounts the bucket the same way as the API).
 * It only reads metadata: nothing is created, written or changed.
 */
export async function isMountPoint(path: string): Promise<boolean> {
  const listed = await readFile('/proc/mounts', 'utf8')
    .then((text) => text.split('\n').some((line) => unescapeMountPath(line.split(' ')[1] ?? '') === path))
    .catch(() => false);
  if (listed) return true;
  const [own, parent] = await Promise.all([stat(path).catch(() => null), stat(dirname(path)).catch(() => null)]);
  return Boolean(own?.isDirectory() && parent && own.dev !== parent.dev);
}
