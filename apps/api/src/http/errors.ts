import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';

export type ErrorBody = { error: { code: string; message: string } };

export function sendError(reply: FastifyReply, statusCode: number, code: string, message: string): FastifyReply {
  const body: ErrorBody = { error: { code, message } };
  return reply.code(statusCode).send(body);
}

const CLIENT_ERROR_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

/** Consistent `{ error: { code, message } }` responses. Internal error details are never returned. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Request validation failed.');
    }
    const statusCode = error.statusCode ?? 500;
    if (statusCode === 429) {
      return sendError(reply, 429, 'RATE_LIMITED', 'Too many attempts. Try again later.');
    }
    if (statusCode >= 400 && statusCode < 500) {
      return sendError(reply, statusCode, CLIENT_ERROR_CODES[statusCode] ?? 'REQUEST_ERROR', error.message);
    }
    request.log.error({ err: error }, 'Unhandled request error');
    return sendError(reply, 500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
  });

  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, 'NOT_FOUND', 'Route not found.'));
}
