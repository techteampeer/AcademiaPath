import type { FastifyReply } from 'fastify';
import type { AppConfig } from '../config.js';

function baseCookieOptions(config: AppConfig) {
  return {
    httpOnly: true,
    secure: config.session.cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
  };
}

export function setSessionCookie(reply: FastifyReply, config: AppConfig, token: string): void {
  reply.setCookie(config.session.cookieName, token, {
    ...baseCookieOptions(config),
    maxAge: config.session.ttlSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(config.session.cookieName, baseCookieOptions(config));
}
