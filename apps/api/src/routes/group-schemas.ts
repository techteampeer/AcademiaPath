// JSON schemas mirroring the student group operations in packages/contract/openapi.yaml (AP-028).
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
const courseRole = { type: ['string', 'null'], enum: ['design_team', 'instructor', 'non_editing_instructor', 'student', null] } as const;
const personRef = { type: 'object', required: ['id', 'name'], additionalProperties: false, properties: { id: uuid, name: { type: 'string' } } } as const;
const name = { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' } as const;
const description = { type: ['string', 'null'], maxLength: 1000 } as const;

export const groupParamsSchema = { type: 'object', required: ['groupId'], additionalProperties: false, properties: { groupId: uuid } } as const;
export const groupMemberParamsSchema = {
  type: 'object',
  required: ['groupId', 'userId'],
  additionalProperties: false,
  properties: { groupId: uuid, userId: uuid },
} as const;

export const groupInputSchema = { type: 'object', required: ['name'], additionalProperties: false, properties: { name, description } } as const;
export const groupUpdateSchema = { type: 'object', minProperties: 1, additionalProperties: false, properties: { name, description } } as const;
export const memberAddSchema = {
  type: 'object',
  required: ['userIds'],
  additionalProperties: false,
  properties: { userIds: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: uuid } },
} as const;

const groupSummaryProperties = {
  id: uuid,
  course: courseRef,
  name: { type: 'string' },
  description: { type: ['string', 'null'] },
  archived: { type: 'boolean' },
  isMember: { type: 'boolean' },
  memberCount: count,
  /** Discussions the caller may see (hidden topics only for moderators). */
  topicCount: count,
  lastActivityAt: nullableDateTime,
  /** The caller's unread notifications about this group's discussions. */
  unreadCount: count,
  createdAt: dateTime,
} as const;
export const groupSummarySchema = { type: 'object', required: Object.keys(groupSummaryProperties), additionalProperties: false, properties: groupSummaryProperties } as const;

export const courseGroupListSchema = {
  type: 'object',
  required: ['course', 'viewer', 'items'],
  additionalProperties: false,
  properties: {
    course: courseRef,
    viewer: {
      type: 'object',
      required: ['role', 'canManage', 'canViewAll'],
      additionalProperties: false,
      properties: { role: courseRole, canManage: { type: 'boolean' }, canViewAll: { type: 'boolean' } },
    },
    items: { type: 'array', items: groupSummarySchema },
  },
} as const;

export const myGroupListSchema = { type: 'object', required: ['items'], additionalProperties: false, properties: { items: { type: 'array', items: groupSummarySchema } } } as const;

export const groupDetailSchema = {
  type: 'object',
  required: ['group', 'viewer', 'members', 'recentTopics', 'membershipChanges', 'candidates'],
  additionalProperties: false,
  properties: {
    group: groupSummarySchema,
    viewer: {
      type: 'object',
      required: ['role', 'isMember', 'canManage', 'canRead', 'canPost', 'canModerate'],
      additionalProperties: false,
      properties: {
        role: courseRole,
        isMember: { type: 'boolean' },
        canManage: { type: 'boolean' },
        canRead: { type: 'boolean' },
        canPost: { type: 'boolean' },
        canModerate: { type: 'boolean' },
      },
    },
    members: {
      type: 'array',
      items: { type: 'object', required: ['id', 'name', 'addedAt'], additionalProperties: false, properties: { id: uuid, name: { type: 'string' }, addedAt: dateTime } },
    },
    /** Latest discussion activity; empty for callers who cannot read the group's discussions. */
    recentTopics: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'replyCount', 'lastActivityAt', 'pinned', 'locked'],
        additionalProperties: false,
        properties: { id: uuid, title: { type: 'string' }, replyCount: count, lastActivityAt: dateTime, pinned: { type: 'boolean' }, locked: { type: 'boolean' } },
      },
    },
    /** Teaching staff and administrators only (empty for students). */
    membershipChanges: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'person', 'actor', 'at'],
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['group_created', 'member_added', 'member_removed', 'group_archived'] },
          person: { ...personRef, type: ['object', 'null'] },
          actor: { ...personRef, type: ['object', 'null'] },
          at: dateTime,
        },
      },
    },
    /** Students of the course who can be added (managers only; empty otherwise). */
    candidates: { type: 'array', items: personRef },
  },
} as const;

export const memberAddResultSchema = {
  type: 'object',
  required: ['added', 'alreadyMembers'],
  additionalProperties: false,
  properties: { added: count, alreadyMembers: count },
} as const;
export const memberRemoveResultSchema = { type: 'object', required: ['removed'], additionalProperties: false, properties: { removed: { type: 'boolean' } } } as const;

export const adminGroupOverviewSchema = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['course', 'activeGroups', 'archivedGroups', 'memberships', 'studentsWithoutGroup'],
        additionalProperties: false,
        properties: { course: courseRef, activeGroups: count, archivedGroups: count, memberships: count, studentsWithoutGroup: count },
      },
    },
  },
} as const;
