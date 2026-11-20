import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { documentStorageIntents } from '../db/schema/index.js';

/**
 * AP-040R: the writer's side of the document storage write-ahead journal (`document_storage_intents`).
 *
 * A file write and a database commit cannot be atomic, and a process can die between them: try/catch clean-up never
 * runs then. So every key is journaled, in its own committed statement, BEFORE its file is written. The transaction
 * that makes the files referenced takes its entries back in the same commit (`settle`); a handled failure removes the
 * files and then forgets their entries (`release`). Whatever is left behind past its lease belongs to a writer that died
 * or could not clean up, and storage recovery may remove it (documents/storage-recovery.ts).
 *
 * The lease is renewed every time the writer journals another file, so a slow but living writer is never treated as
 * abandoned; and if recovery did take a slow writer's entries, `settle` sees it and the writer aborts instead of
 * referencing files that may be gone.
 */

/** How long a writer may go without renewing its lease before its files may be recovered (30 minutes). */
export const STORAGE_INTENT_LEASE_SECONDS = 30 * 60;

export type StorageJournalOperation = 'archive_import';

export class StorageJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageJournalError';
  }
}

export type StorageJournal = {
  readonly operationId: string;
  /** Journals a new key (and renews this operation's lease) before its file is written; returns the key to write. */
  reserve(): Promise<string>;
  /** In the committing transaction: takes back exactly these entries, or throws if storage recovery took any of them. */
  settle(tx: Pick<Database, 'delete'>, keys: string[]): Promise<void>;
  /** After a handled failure: forgets the entries of files that were removed. */
  release(keys: string[]): Promise<void>;
};

export function openStorageJournal(
  db: Pick<Database, 'insert' | 'update' | 'delete'>,
  operation: StorageJournalOperation,
  actorUserId: string | null,
  options: { leaseSeconds?: number } = {},
): StorageJournal {
  const operationId = randomUUID();
  const lease = options.leaseSeconds ?? STORAGE_INTENT_LEASE_SECONDS;
  const expiry = () => sql`now() + make_interval(secs => ${lease})`;
  return {
    operationId,
    async reserve() {
      const storageKey = randomUUID();
      await db.insert(documentStorageIntents).values({ storageKey, operation, operationId, actorUserId, leaseExpiresAt: expiry() });
      await db.update(documentStorageIntents).set({ leaseExpiresAt: expiry() }).where(eq(documentStorageIntents.operationId, operationId));
      return storageKey;
    },
    async settle(tx, keys) {
      if (!keys.length) return;
      const settled = await tx
        .delete(documentStorageIntents)
        .where(and(eq(documentStorageIntents.operationId, operationId), inArray(documentStorageIntents.storageKey, keys)))
        .returning({ storageKey: documentStorageIntents.storageKey });
      if (settled.length !== keys.length) throw new StorageJournalError('Storage recovery reclaimed files of this operation before it committed');
    },
    async release(keys) {
      if (!keys.length) return;
      await db.delete(documentStorageIntents).where(and(eq(documentStorageIntents.operationId, operationId), inArray(documentStorageIntents.storageKey, keys)));
    },
  };
}
