// JSON schemas mirroring the messaging and notification operations in packages/contract/openapi.yaml (AP-026).
const uuid = { type: 'string', format: 'uuid' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' } as const;
const seq = { type: 'integer', minimum: 0 } as const;
const courseRef = {
  type: 'object',
  required: ['id', 'title', 'code'],
  additionalProperties: false,
  properties: { id: uuid, title: { type: 'string' }, code: { type: 'string' } },
} as const;
const courseRole = { type: 'string', enum: ['student', 'instructor', 'non_editing_instructor'] } as const;
const person = {
  type: 'object',
  required: ['id', 'name', 'role'],
  additionalProperties: false,
  properties: { id: uuid, name: { type: 'string' }, role: { type: ['string', 'null'], enum: ['student', 'instructor', 'non_editing_instructor', null] } },
} as const;

export const conversationParamsSchema = { type: 'object', required: ['conversationId'], additionalProperties: false, properties: { conversationId: uuid } } as const;
export const messageParamsSchema = {
  type: 'object',
  required: ['conversationId', 'messageId'],
  additionalProperties: false,
  properties: { conversationId: uuid, messageId: uuid },
} as const;
export const notificationParamsSchema = { type: 'object', required: ['notificationId'], additionalProperties: false, properties: { notificationId: uuid } } as const;

export const conversationSchema = {
  type: 'object',
  required: ['id', 'kind', 'course', 'counterpart', 'locked', 'canPost', 'canModerate', 'unreadCount', 'lastMessage'],
  additionalProperties: false,
  properties: {
    id: uuid,
    kind: { type: 'string', enum: ['direct', 'course'] },
    course: courseRef,
    counterpart: { ...person, type: ['object', 'null'] },
    locked: { type: 'boolean' },
    canPost: { type: 'boolean' },
    canModerate: { type: 'boolean' },
    unreadCount: { type: 'integer', minimum: 0 },
    lastMessage: {
      type: ['object', 'null'],
      required: ['senderName', 'preview', 'createdAt'],
      additionalProperties: false,
      properties: { senderName: { type: 'string' }, preview: { type: ['string', 'null'] }, createdAt: dateTime },
    },
  },
} as const;

export const conversationPageSchema = {
  type: 'object',
  required: ['items', 'nextCursor'],
  additionalProperties: false,
  properties: { items: { type: 'array', items: conversationSchema }, nextCursor: { type: ['string', 'null'] } },
} as const;

export const conversationListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }, cursor: { type: 'string', maxLength: 500 } },
} as const;

export const courseMessagingSchema = {
  type: 'object',
  required: ['course', 'role', 'courseConversation', 'directConversations', 'contacts'],
  additionalProperties: false,
  properties: {
    course: courseRef,
    role: courseRole,
    courseConversation: { ...conversationSchema, type: ['object', 'null'] },
    directConversations: { type: 'array', items: conversationSchema },
    contacts: { type: 'array', items: person },
  },
} as const;

export const directConversationInputSchema = {
  type: 'object',
  required: ['recipientUserId'],
  additionalProperties: false,
  properties: { recipientUserId: uuid },
} as const;

export const messageSchema = {
  type: 'object',
  required: ['id', 'seq', 'sender', 'body', 'hidden', 'mine', 'createdAt'],
  additionalProperties: false,
  properties: {
    id: uuid,
    seq,
    sender: person,
    body: { type: ['string', 'null'], description: 'Plain text; null when hidden by moderation.' },
    hidden: { type: 'boolean' },
    mine: { type: 'boolean' },
    createdAt: dateTime,
  },
} as const;

export const messagePageSchema = {
  type: 'object',
  required: ['items', 'olderCursor', 'latestSeq', 'readSeq'],
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: messageSchema },
    /** Pass as `before` to load older messages; null when there are none. */
    olderCursor: { type: ['integer', 'null'], minimum: 0 },
    latestSeq: { type: ['integer', 'null'], minimum: 0 },
    readSeq: seq,
  },
} as const;

export const messageListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { before: seq, after: seq, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } },
} as const;

export const messageInputSchema = {
  type: 'object',
  required: ['body', 'clientMessageId'],
  additionalProperties: false,
  properties: { body: { type: 'string', minLength: 1, maxLength: 4000, pattern: '\\S' }, clientMessageId: uuid },
} as const;

export const readInputSchema = { type: 'object', required: ['upToSeq'], additionalProperties: false, properties: { upToSeq: seq } } as const;

export const messagingSummarySchema = {
  type: 'object',
  required: ['unreadMessages', 'unreadNotifications'],
  additionalProperties: false,
  properties: { unreadMessages: { type: 'integer', minimum: 0 }, unreadNotifications: { type: 'integer', minimum: 0 } },
} as const;

export const adminCourseConversationListSchema = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['course', 'conversationId', 'locked', 'messageCount', 'lastMessageAt'],
        additionalProperties: false,
        properties: { course: courseRef, conversationId: { type: ['string', 'null'], format: 'uuid' }, locked: { type: 'boolean' }, messageCount: { type: 'integer', minimum: 0 }, lastMessageAt: nullableDateTime },
      },
    },
  },
} as const;

export const lockResultSchema = {
  type: 'object',
  required: ['conversationId', 'locked'],
  additionalProperties: false,
  properties: { conversationId: uuid, locked: { type: 'boolean' } },
} as const;

const notificationData = { type: 'object', additionalProperties: { type: 'string' }, maxProperties: 10 } as const;

export const notificationSchema = {
  type: 'object',
  required: ['id', 'type', 'course', 'data', 'link', 'eventAt', 'read'],
  additionalProperties: false,
  properties: {
    id: uuid,
    type: { type: 'string', enum: ['direct_message', 'course_message', 'announcement', 'grade_released', 'certificate_issued', 'forum_reply', 'forum_topic'] },
    course: { ...courseRef, type: ['object', 'null'] },
    data: notificationData,
    link: { type: 'string' },
    eventAt: dateTime,
    read: { type: 'boolean' },
  },
} as const;

export const notificationPageSchema = {
  type: 'object',
  required: ['items', 'nextCursor'],
  additionalProperties: false,
  properties: { items: { type: 'array', items: notificationSchema }, nextCursor: { type: ['string', 'null'] } },
} as const;

export const notificationListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    cursor: { type: 'string', maxLength: 500 },
    unread: { type: 'boolean', default: false },
  },
} as const;

export const readAllResultSchema = { type: 'object', required: ['updated'], additionalProperties: false, properties: { updated: { type: 'integer', minimum: 0 } } } as const;
