import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { Database } from './db/client.js';
import { auditLog } from './db/schema/index.js';

/** Only valid IPs are audited; a malformed forwarded address must not break a request. */
export const auditIp = (ip: string) => (isIP(ip) ? ip : null);

export type AuditChange = {
  action: string;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

/**
 * Appends an audit record: actor (signed-in user), action, object, time (database default) and
 * before/after data. Callers pass business fields only, never credentials or tokens.
 */
export async function recordAudit(db: Pick<Database, 'insert'>, request: FastifyRequest, change: AuditChange) {
  await db.insert(auditLog).values({
    actorUserId: request.auth?.user.id ?? null,
    action: change.action,
    entityType: change.entityType,
    entityId: change.entityId,
    metadata: { before: change.before, after: change.after },
    ipAddress: auditIp(request.ip),
  });
}
