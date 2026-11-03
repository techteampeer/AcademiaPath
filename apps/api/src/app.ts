import Fastify, { type FastifyServerOptions } from 'fastify';
import { healthRoutes } from './routes/health.js';

export const API_PREFIX = '/api/v1';

export function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options);

  app.register(healthRoutes, { prefix: API_PREFIX });

  return app;
}
