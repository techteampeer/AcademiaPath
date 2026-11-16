import type { FastifyPluginAsync } from 'fastify';

const storageReadinessSchema = {
  type: 'object',
  required: ['status', 'mountCheck', 'directory', 'access', 'mount', 'checkedAt'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['ready', 'degraded', 'unavailable'] },
    mountCheck: { type: 'string', enum: ['off', 'report', 'enforce'] },
    directory: { type: 'string', enum: ['present', 'missing', 'not_a_directory'] },
    access: { type: 'string', enum: ['read_write', 'denied', 'not_checked'] },
    mount: { type: 'string', enum: ['mounted', 'not_mounted', 'not_checked'] },
    checkedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/**
 * AP-040B: administrators can see whether document storage is ready, so a deployment's storage mount can be verified
 * without cloud console access. Read-only, checked on each request; no path, file name or file count is returned.
 */
export const systemRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/system/storage',
    { preValidation: [app.requireAuth, app.requireAdministrator], schema: { response: { 200: storageReadinessSchema } } },
    async (_request, reply) => {
      reply.header('cache-control', 'no-store');
      return app.storageReadiness();
    },
  );
};
