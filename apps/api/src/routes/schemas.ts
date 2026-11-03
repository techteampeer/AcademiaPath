import { localeEnum, systemRoleEnum } from '../db/schema/index.js';

// JSON schemas mirroring packages/contract/openapi.yaml. Response schemas list every allowed
// property with additionalProperties: false, so serialization drops anything not declared here.

export const loginBodySchema = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', minLength: 1, maxLength: 254 },
    password: { type: 'string', minLength: 1, maxLength: 1024 },
  },
} as const;

export const currentUserSchema = {
  type: 'object',
  required: ['id', 'email', 'givenName', 'familyName', 'systemRole', 'preferredLocale'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    givenName: { type: 'string' },
    familyName: { type: 'string' },
    systemRole: { type: 'string', enum: systemRoleEnum.enumValues },
    preferredLocale: { type: 'string', enum: localeEnum.enumValues },
  },
} as const;

export const loginResponseSchema = {
  type: 'object',
  required: ['user', 'csrfToken', 'expiresAt'],
  additionalProperties: false,
  properties: {
    user: currentUserSchema,
    csrfToken: { type: 'string' },
    expiresAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const meResponseSchema = {
  type: 'object',
  required: ['user'],
  additionalProperties: false,
  properties: { user: currentUserSchema },
} as const;

export const csrfTokenResponseSchema = {
  type: 'object',
  required: ['csrfToken'],
  additionalProperties: false,
  properties: { csrfToken: { type: 'string' } },
} as const;
