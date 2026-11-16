// JSON schemas mirroring the course e-mail composition operation in packages/contract/openapi.yaml (AP-044).

export const courseEmailRecipientsSchema = {
  type: 'object',
  required: ['course', 'recipientCount', 'recipients', 'excluded'],
  additionalProperties: false,
  properties: {
    course: {
      type: 'object',
      required: ['id', 'code', 'title'],
      additionalProperties: false,
      properties: { id: { type: 'string', format: 'uuid' }, code: { type: 'string' }, title: { type: 'string' } },
    },
    recipientCount: { type: 'integer', minimum: 0 },
    recipients: {
      type: 'array',
      items: { type: 'object', required: ['name', 'email'], additionalProperties: false, properties: { name: { type: 'string' }, email: { type: 'string' } } },
    },
    excluded: {
      type: 'object',
      required: ['invalidEmail', 'duplicateEmail'],
      additionalProperties: false,
      properties: { invalidEmail: { type: 'integer', minimum: 0 }, duplicateEmail: { type: 'integer', minimum: 0 } },
    },
  },
} as const;
