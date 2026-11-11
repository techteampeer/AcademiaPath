// JSON schemas mirroring the forum operations in packages/contract/openapi.yaml (AP-027).
const uuid = { type: 'string', format: 'uuid' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' } as const;
const count = { type: 'integer', minimum: 0 } as const;
const courseRef = {
  type: 'object',
  required: ['id', 'title', 'code'],
  additionalProperties: false,
  properties: { id: uuid, title: { type: 'string' }, code: { type: 'string' } },
} as const;
const forumRole = { type: ['string', 'null'], enum: ['student', 'instructor', 'non_editing_instructor', null] } as const;
const person = {
  type: 'object',
  required: ['id', 'name', 'role'],
  additionalProperties: false,
  properties: { id: uuid, name: { type: 'string' }, role: forumRole },
} as const;
const title = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } as const;
const body = { type: 'string', minLength: 1, maxLength: 10000, pattern: '\\S' } as const;

export const topicParamsSchema = { type: 'object', required: ['topicId'], additionalProperties: false, properties: { topicId: uuid } } as const;
export const postParamsSchema = { type: 'object', required: ['postId'], additionalProperties: false, properties: { postId: uuid } } as const;

const viewerSchema = {
  type: 'object',
  required: ['role', 'canPost', 'canModerate'],
  additionalProperties: false,
  properties: { role: forumRole, canPost: { type: 'boolean' }, canModerate: { type: 'boolean' } },
} as const;

const topicSummaryProperties = {
  id: uuid,
  title: { type: 'string' },
  excerpt: { type: 'string' },
  author: person,
  mine: { type: 'boolean' },
  pinned: { type: 'boolean' },
  locked: { type: 'boolean' },
  hidden: { type: 'boolean', description: 'Only moderators ever receive hidden topics.' },
  replyCount: count,
  lastReply: {
    type: ['object', 'null'],
    required: ['authorName', 'createdAt'],
    additionalProperties: false,
    properties: { authorName: { type: 'string' }, createdAt: dateTime },
  },
  lastActivityAt: dateTime,
  createdAt: dateTime,
  editedAt: nullableDateTime,
} as const;
const topicSummaryRequired = Object.keys(topicSummaryProperties);

export const topicSummarySchema = { type: 'object', required: topicSummaryRequired, additionalProperties: false, properties: topicSummaryProperties } as const;

export const topicPageSchema = {
  type: 'object',
  required: ['course', 'viewer', 'items', 'nextCursor'],
  additionalProperties: false,
  properties: { course: courseRef, viewer: viewerSchema, items: { type: 'array', items: topicSummarySchema }, nextCursor: { type: ['string', 'null'] } },
} as const;

export const topicListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    cursor: { type: 'string', minLength: 1, maxLength: 500 },
    q: { type: 'string', minLength: 1, maxLength: 100 },
  },
} as const;

export const topicSchema = {
  type: 'object',
  required: [...topicSummaryRequired, 'course', 'body', 'canReply', 'canEdit', 'canModerate', 'editableUntil'],
  additionalProperties: false,
  properties: {
    ...topicSummaryProperties,
    course: courseRef,
    body: { type: 'string', description: 'Plain text.' },
    canReply: { type: 'boolean' },
    canEdit: { type: 'boolean' },
    canModerate: { type: 'boolean' },
    editableUntil: nullableDateTime,
  },
} as const;

export const topicInputSchema = {
  type: 'object',
  required: ['title', 'body', 'clientRequestId'],
  additionalProperties: false,
  properties: { title, body, clientRequestId: uuid, announce: { type: 'boolean', default: false } },
} as const;

export const topicUpdateSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: { title, body },
} as const;

const postProperties = {
  id: uuid,
  number: { type: 'integer', minimum: 1 },
  parentPostId: { type: ['string', 'null'], format: 'uuid' },
  author: person,
  body: { type: 'string', description: 'Plain text.' },
  hidden: { type: 'boolean', description: 'Only moderators ever receive hidden replies.' },
  mine: { type: 'boolean' },
  canEdit: { type: 'boolean' },
  editableUntil: nullableDateTime,
  createdAt: dateTime,
  editedAt: nullableDateTime,
} as const;
export const postSchema = { type: 'object', required: Object.keys(postProperties), additionalProperties: false, properties: postProperties } as const;

export const threadItemSchema = {
  type: 'object',
  required: [...Object.keys(postProperties), 'replies'],
  additionalProperties: false,
  properties: { ...postProperties, replies: { type: 'array', items: postSchema } },
} as const;

export const postPageSchema = {
  type: 'object',
  required: ['items', 'nextCursor', 'total'],
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: threadItemSchema },
    /** Pass as `after` for the next replies; null when there are none. */
    nextCursor: { type: ['integer', 'null'], minimum: 1 },
    total: count,
  },
} as const;

export const postListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
} as const;

export const postInputSchema = {
  type: 'object',
  required: ['body', 'clientRequestId'],
  additionalProperties: false,
  properties: { body, clientRequestId: uuid, parentPostId: uuid },
} as const;

export const postUpdateSchema = { type: 'object', required: ['body'], additionalProperties: false, properties: { body } } as const;

export const topicModerationSchema = {
  type: 'object',
  required: ['action'],
  additionalProperties: false,
  properties: { action: { type: 'string', enum: ['pin', 'unpin', 'lock', 'unlock', 'hide', 'restore'] } },
} as const;

export const postModerationSchema = {
  type: 'object',
  required: ['action'],
  additionalProperties: false,
  properties: { action: { type: 'string', enum: ['hide', 'restore'] } },
} as const;

export const adminForumCourseListSchema = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['course', 'topicCount', 'replyCount', 'lockedTopicCount', 'hiddenTopicCount', 'hiddenReplyCount', 'lastActivityAt'],
        additionalProperties: false,
        properties: {
          course: courseRef,
          topicCount: count,
          replyCount: count,
          lockedTopicCount: count,
          hiddenTopicCount: count,
          hiddenReplyCount: count,
          lastActivityAt: nullableDateTime,
        },
      },
    },
  },
} as const;
