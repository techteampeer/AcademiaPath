import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { alias } from 'drizzle-orm/pg-core';
import { grantedProgramIds } from '../academics/program-access.js';
import { recordAudit } from '../audit.js';
import { isAdministrator } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import { withUniqueConflict } from '../db/errors.js';
import { programManagers, programs, users } from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;

const programParamsSchema = { type: 'object', required: ['programId'], additionalProperties: false, properties: { programId: uuid } } as const;
const managerParamsSchema = {
  type: 'object',
  required: ['programId', 'userId'],
  additionalProperties: false,
  properties: { programId: uuid, userId: uuid },
} as const;
const grantSchema = {
  type: 'object',
  additionalProperties: false,
  oneOf: [{ required: ['userId'] }, { required: ['email'] }],
  properties: { userId: uuid, email: { type: 'string', minLength: 1, maxLength: 254 } },
} as const;
const managerSchema = {
  type: 'object',
  required: ['programId', 'user', 'grantedAt', 'grantedBy'],
  additionalProperties: false,
  properties: {
    programId: uuid,
    user: {
      type: 'object',
      required: ['id', 'email', 'givenName', 'familyName', 'isActive'],
      additionalProperties: false,
      properties: { id: uuid, email: { type: 'string' }, givenName: { type: 'string' }, familyName: { type: 'string' }, isActive: { type: 'boolean' } },
    },
    grantedAt: dateTime,
    grantedBy: { type: ['object', 'null'], required: ['id', 'email'], additionalProperties: false, properties: { id: uuid, email: { type: 'string' } } },
  },
} as const;
const managerListSchema = { type: 'object', required: ['items'], additionalProperties: false, properties: { items: { type: 'array', items: managerSchema } } } as const;
const managedProgramListSchema = {
  type: 'object',
  required: ['scope', 'items'],
  additionalProperties: false,
  properties: {
    scope: { type: 'string', enum: ['all', 'granted'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'code', 'name', 'description', 'isActive', 'subjectCount'],
        additionalProperties: false,
        properties: {
          id: uuid,
          code: { type: 'string' },
          name: { type: 'string' },
          description: { type: ['string', 'null'] },
          isActive: { type: 'boolean' },
          subjectCount: { type: 'integer', minimum: 0 },
        },
      },
    },
  },
} as const;

const programNotFound = () => new ApiProblem(404, 'NOT_FOUND', 'Program not found.');
const grantedBy = alias(users, 'granted_by');

/**
 * Program-scoped academic management grants. Only administrators list, grant and revoke them; any
 * signed-in user may list the programs they themselves manage.
 */
export const programManagerRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const adminRead = { preValidation: [app.requireAuth, app.requireAdministrator] };
  const adminWrite = { preValidation: [app.requireAuth, app.requireCsrf, app.requireAdministrator] };

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  const managerColumns = {
    programId: programManagers.programId,
    grantedAt: programManagers.createdAt,
    user: { id: users.id, email: users.email, givenName: users.givenName, familyName: users.familyName, isActive: users.isActive },
    grantedById: grantedBy.id,
    grantedByEmail: grantedBy.email,
  };
  const present = ({ grantedById, grantedByEmail, ...row }: { grantedById: string | null; grantedByEmail: string | null } & Record<string, unknown>) => ({
    ...row,
    grantedBy: grantedById && grantedByEmail ? { id: grantedById, email: grantedByEmail } : null,
  });
  const managersOf = (programId: string, userId?: string) =>
    db
      .select(managerColumns)
      .from(programManagers)
      .innerJoin(users, eq(users.id, programManagers.userId))
      .leftJoin(grantedBy, eq(grantedBy.id, programManagers.grantedByUserId))
      .where(and(eq(programManagers.programId, programId), userId ? eq(programManagers.userId, userId) : undefined))
      .orderBy(sql`lower(${users.email})`);

  app.get('/me/managed-programs', { preValidation: [app.requireAuth], schema: { response: { 200: managedProgramListSchema } } }, async (request) => {
    const { user } = getAuth(request);
    const admin = isAdministrator(user);
    const ids = admin ? null : await grantedProgramIds(db, user);
    if (ids !== null && ids.length === 0) return { scope: 'granted', items: [] };
    const items = await db
      .select({
        id: programs.id,
        code: programs.code,
        name: programs.name,
        description: programs.description,
        isActive: programs.isActive,
        // Correlated subquery: the outer column is written fully qualified (Drizzle renders single-table columns unqualified).
        subjectCount: sql<number>`(SELECT count(*)::int FROM course_templates ct WHERE ct.program_id = "programs"."id")`,
      })
      .from(programs)
      .where(ids ? inArray(programs.id, ids) : undefined)
      .orderBy(asc(programs.code));
    return { scope: admin ? 'all' : 'granted', items };
  });

  app.get<{ Params: { programId: string } }>(
    '/programs/:programId/managers',
    { ...adminRead, schema: { params: programParamsSchema, response: { 200: managerListSchema } } },
    async (request) => {
      const [program] = await db.select({ id: programs.id }).from(programs).where(eq(programs.id, request.params.programId));
      if (!program) throw programNotFound();
      return { items: (await managersOf(program.id)).map(present) };
    },
  );

  app.post<{ Params: { programId: string }; Body: { userId?: string; email?: string } }>(
    '/programs/:programId/managers',
    { ...adminWrite, schema: { params: programParamsSchema, body: grantSchema, response: { 201: managerSchema } } },
    async (request, reply) => {
      const { userId, email } = request.body;
      const grantedUserId = await db.transaction(async (tx) => {
        const [program] = await tx.select({ id: programs.id }).from(programs).where(eq(programs.id, request.params.programId));
        if (!program) throw programNotFound();
        const [target] = await tx
          .select({ id: users.id, isActive: users.isActive })
          .from(users)
          .where(userId ? eq(users.id, userId) : sql`lower(${users.email}) = lower(${(email ?? '').trim()})`)
          .for('share');
        if (!target) throw new ApiProblem(422, 'USER_NOT_FOUND', 'The user does not exist.');
        if (!target.isActive) throw new ApiProblem(422, 'USER_INACTIVE', 'The user account is not active.');
        const [grant] = await withUniqueConflict(
          () => tx.insert(programManagers).values({ programId: program.id, userId: target.id, grantedByUserId: getAuth(request).user.id }).returning(),
          'program_managers_program_id_user_id_unique',
          'PROGRAM_MANAGER_EXISTS',
          'This user already manages the program.',
        );
        if (!grant) throw new Error('Grant was not created');
        await recordAudit(tx, request, {
          action: 'program_manager.granted',
          entityType: 'program',
          entityId: program.id,
          before: null,
          after: { programId: program.id, userId: target.id },
        });
        return target.id;
      });
      const [created] = await managersOf(request.params.programId, grantedUserId);
      return reply.code(201).send(present(created!));
    },
  );

  app.delete<{ Params: { programId: string; userId: string } }>(
    '/programs/:programId/managers/:userId',
    { ...adminWrite, schema: { params: managerParamsSchema } },
    async (request, reply) => {
      await db.transaction(async (tx) => {
        // Waits for any subject write that holds this grant (FOR SHARE), then removes it for good.
        const [removed] = await tx
          .delete(programManagers)
          .where(and(eq(programManagers.programId, request.params.programId), eq(programManagers.userId, request.params.userId)))
          .returning();
        if (!removed) throw new ApiProblem(404, 'NOT_FOUND', 'This user does not manage the program.');
        await recordAudit(tx, request, {
          action: 'program_manager.revoked',
          entityType: 'program',
          entityId: removed.programId,
          before: { programId: removed.programId, userId: removed.userId, grantedAt: removed.createdAt.toISOString() },
          after: null,
        });
      });
      return reply.code(204).send();
    },
  );
};
