import { STATUS_CODES } from 'node:http';
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * RFC 9457 Problem Details. `type` is "about:blank" (the HTTP status code is the problem type),
 * so `title` is the standard status phrase. `code` is an application-specific extension member.
 */
export type ProblemDetails = {
  type: 'about:blank';
  title: string;
  status: number;
  detail: string;
  code: string;
};

export function sendError(reply: FastifyReply, status: number, code: string, detail: string): FastifyReply {
  const problem: ProblemDetails = {
    type: 'about:blank',
    title: STATUS_CODES[status] ?? 'Error',
    status,
    detail,
    code,
  };
  return reply.code(status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

const CLIENT_ERROR_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

/** All errors become RFC 9457 problem details. Internal error details are never returned. */
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
