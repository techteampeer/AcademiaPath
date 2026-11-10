// JSON schemas mirroring the learning-resource operations in packages/contract/openapi.yaml (AP-021).

const uuid = { type: 'string', format: 'uuid' } as const;
const title = { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' } as const;

export const folderParamsSchema = {
  type: 'object',
  required: ['id', 'folderId'],
  additionalProperties: false,
  properties: { id: uuid, folderId: uuid },
} as const;

export const resourceFolderSchema = {
  type: 'object',
  required: ['id', 'sectionId', 'title', 'position'],
  additionalProperties: false,
  properties: { id: uuid, sectionId: uuid, title: { type: 'string' }, position: { type: 'integer' } },
} as const;

export const resourceFolderListSchema = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: { items: { type: 'array', items: resourceFolderSchema } },
} as const;

export const resourceFolderInputSchema = {
  type: 'object',
  required: ['title'],
  additionalProperties: false,
  properties: { title },
} as const;

export const folderOrderSchema = {
  type: 'object',
  required: ['folderIds'],
  additionalProperties: false,
  properties: { folderIds: { type: 'array', maxItems: 100, uniqueItems: true, items: uuid } },
} as const;

export const activityOrderSchema = {
  type: 'object',
  required: ['activityIds'],
  additionalProperties: false,
  properties: { activityIds: { type: 'array', maxItems: 500, uniqueItems: true, items: uuid } },
} as const;

export const activityOrganizationSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: { folderId: { type: ['string', 'null'], format: 'uuid' }, isVisible: { type: 'boolean' } },
} as const;

export const activityOrderResultSchema = {
  type: 'object',
  required: ['activityIds'],
  additionalProperties: false,
  properties: { activityIds: { type: 'array', items: uuid } },
} as const;
