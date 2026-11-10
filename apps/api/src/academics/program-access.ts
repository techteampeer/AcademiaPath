import { and, eq, sql } from 'drizzle-orm';
import { isAdministrator } from '../auth/authorization.js';
import type { SafeUser } from '../auth/types.js';
import type { Database } from '../db/client.js';
import { programManagers, users } from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Tx;

export const notProgramManager = () => new ApiProblem(403, 'FORBIDDEN', 'You do not manage this program.');

/**
 * Programs the user may manage through an explicit grant (administrators manage every program and
 * are handled by the callers). Only grants of active accounts count.
 */
export async function grantedProgramIds(db: Executor, user: SafeUser): Promise<string[]> {
  const rows = await db
    .select({ programId: programManagers.programId })
    .from(programManagers)
    .innerJoin(users, eq(users.id, programManagers.userId))
    .where(and(eq(programManagers.userId, user.id), eq(users.isActive, true)));
  return rows.map((row) => row.programId);
}

/** Read check: administrator, or an active grant for the program. Default deny (null program included). */
export async function canReadProgram(db: Executor, user: SafeUser, programId: string | null): Promise<boolean> {
  if (isAdministrator(user)) return true;
  if (!programId) return false;
  return (await grantedProgramIds(db, user)).includes(programId);
}

/**
 * Write check, run inside the writing transaction: administrator, or an active grant for the program.
 * The grant and user rows are locked FOR SHARE until the transaction ends, so a concurrent revocation
 * (DELETE) or deactivation (UPDATE) waits for this write to finish, and any write that starts after
 * them sees the change and is refused. `programId` must come from stored data (the subject being
 * versioned) or be the target of a new subject; it is never trusted on its own.
 */
export async function assertCanManageProgram(tx: Tx, user: SafeUser, programId: string | null): Promise<void> {
  if (isAdministrator(user)) return;
  if (!programId) throw notProgramManager();
  const result = await tx.execute(sql`
    SELECT 1 FROM ${programManagers} pm
    JOIN ${users} u ON u.id = pm.user_id
    WHERE pm.program_id = ${programId} AND pm.user_id = ${user.id} AND u.is_active
    FOR SHARE OF pm, u`);
  if (result.rows.length === 0) throw notProgramManager();
}

/** Narrows a list of program ids to those the user may read (administrators: unchanged). */
export async function readableProgramFilter(db: Executor, user: SafeUser): Promise<string[] | null> {
  if (isAdministrator(user)) return null;
  return grantedProgramIds(db, user);
}

