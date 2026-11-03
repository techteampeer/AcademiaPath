import type { FastifyPluginAsync } from 'fastify';
import { getAuth } from '../auth/hooks.js';
import { meResponseSchema } from './schemas.js';

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  app.get(
    '/me',
    { preHandler: app.requireAuth, schema: { response: { 200: meResponseSchema } } },
    async (request) => ({ user: getAuth(request).user }),
  );
};
