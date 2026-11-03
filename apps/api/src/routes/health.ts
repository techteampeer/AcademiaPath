import type { FastifyPluginAsync } from 'fastify';

// Must stay in sync with HealthResponse in packages/contract/openapi.yaml.
const healthResponseSchema = {
  type: 'object',
  required: ['status', 'service', 'timestamp'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['ok'] },
    service: { type: 'string' },
    timestamp: { type: 'string', format: 'date-time' },
  },
} as const;

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/health',
    { schema: { response: { 200: healthResponseSchema } } },
    async () => ({
      status: 'ok' as const,
      service: 'academiapath-api',
      timestamp: new Date().toISOString(),
    }),
  );
};
