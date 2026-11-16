// JSON schemas mirroring the announcement and calendar operations in packages/contract/openapi.yaml (AP-025).
import { DATE_PATTERN, INSTANT_PATTERN } from '../calendar/time.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' } as const;
const instant = { type: 'string', maxLength: 40, pattern: INSTANT_PATTERN } as const;
const day = { type: 'string', pattern: DATE_PATTERN } as const;
const courseRef = {
  type: ['object', 'null'],
  required: ['id', 'title', 'code'],
  additionalProperties: false,
  properties: { id: uuid, title: { type: 'string' }, code: { type: 'string' } },
} as const;

export const announcementParamsSchema = { type: 'object', required: ['announcementId'], additionalProperties: false, properties: { announcementId: uuid } } as const;
export const eventParamsSchema = { type: 'object', required: ['eventId'], additionalProperties: false, properties: { eventId: uuid } } as const;

const title = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } as const;
const body = { type: 'string', minLength: 1, maxLength: 10000, pattern: '\\S' } as const;

export const announcementCreateSchema = {
  type: 'object',
  required: ['title', 'body'],
  additionalProperties: false,
  properties: { title, body, pinned: { type: 'boolean' } },
} as const;

export const announcementUpdateSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: { title, body, pinned: { type: 'boolean' } },
} as const;

export const announcementPublishSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { publishAt: { ...instant, type: ['string', 'null'] } },
} as const;

export const announcementSchema = {
  type: 'object',
  required: ['id', 'scope', 'course', 'title', 'body', 'status', 'pinned', 'publishAt', 'archivedAt', 'read', 'createdAt', 'updatedAt'],
  additionalProperties: false,
  properties: {
    id: uuid,
    scope: { type: 'string', enum: ['course', 'institution'] },
    course: courseRef,
    title: { type: 'string' },
    body: { type: 'string' },
    status: { type: 'string', enum: ['draft', 'scheduled', 'published', 'archived'] },
    pinned: { type: 'boolean' },
    publishAt: nullableDateTime,
    archivedAt: nullableDateTime,
    read: { type: 'boolean' },
    createdAt: dateTime,
    updatedAt: dateTime,
  },
} as const;

export const announcementPageSchema = {
  type: 'object',
  required: ['items', 'nextCursor'],
  additionalProperties: false,
  properties: { items: { type: 'array', items: announcementSchema }, nextCursor: { type: ['string', 'null'] } },
} as const;

export const announcementListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['all', 'draft', 'scheduled', 'published', 'archived'], default: 'all' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    cursor: { type: 'string', maxLength: 500 },
  },
} as const;

export const feedQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, cursor: { type: 'string', maxLength: 500 } },
} as const;

export const unreadCountSchema = {
  type: 'object',
  required: ['unreadCount'],
  additionalProperties: false,
  properties: { unreadCount: { type: 'integer', minimum: 0 } },
} as const;

// ---- Calendar ----

const sessionModes = ['live_online', 'asynchronous', 'presentation'] as const;
/** AP-045: teaching session details of a course event (the server checks the link, the units and the activity). */
const sessionInput = {
  type: ['object', 'null'],
  required: ['number', 'deliveryMode'],
  additionalProperties: false,
  properties: {
    number: { type: 'integer', minimum: 1, maximum: 999 },
    deliveryMode: { type: 'string', enum: sessionModes },
    joinUrl: { type: ['string', 'null'], maxLength: 2000 },
    unitIds: { type: 'array', maxItems: 20, uniqueItems: true, items: uuid },
    activityId: { type: ['string', 'null'], format: 'uuid' },
  },
} as const;
const sessionView = {
  type: ['object', 'null'],
  required: ['number', 'deliveryMode', 'joinUrl', 'units', 'activity'],
  additionalProperties: false,
  properties: {
    number: { type: 'integer' },
    deliveryMode: { type: 'string', enum: sessionModes },
    joinUrl: { type: ['string', 'null'] },
    units: { type: 'array', items: { type: 'object', required: ['id', 'title'], additionalProperties: false, properties: { id: uuid, title: { type: 'string' } } } },
    activity: {
      type: ['object', 'null'],
      required: ['id', 'title', 'type'],
      additionalProperties: false,
      properties: { id: uuid, title: { type: 'string' }, type: { type: 'string' } },
    },
  },
} as const;

const eventFields = {
  title,
  description: { type: ['string', 'null'], maxLength: 5000 },
  allDay: { type: 'boolean' },
  startsAt: instant,
  endsAt: instant,
  startDate: day,
  endDate: day,
  timeZone: { type: 'string', minLength: 1, maxLength: 64 },
  status: { type: 'string', enum: ['hidden', 'published'] },
  session: sessionInput,
} as const;

/** Timed events send instants (with offsets); all-day events send dates. The server checks the rest. */
export const eventInputSchema = {
  type: 'object',
  required: ['title', 'allDay', 'status'],
  additionalProperties: false,
  properties: eventFields,
  oneOf: [
    { properties: { allDay: { const: false } }, required: ['startsAt', 'endsAt'], not: { anyOf: [{ required: ['startDate'] }, { required: ['endDate'] }] } },
    { properties: { allDay: { const: true } }, required: ['startDate', 'endDate'], not: { anyOf: [{ required: ['startsAt'] }, { required: ['endsAt'] }] } },
  ],
} as const;

export const eventSchema = {
  type: 'object',
  required: ['id', 'scope', 'course', 'title', 'description', 'allDay', 'startsAt', 'endsAt', 'startDate', 'endDate', 'timeZone', 'status', 'publishedAt', 'cancelledAt', 'session', 'createdAt', 'updatedAt'],
  additionalProperties: false,
  properties: {
    id: uuid,
    scope: { type: 'string', enum: ['course', 'institution'] },
    course: courseRef,
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    allDay: { type: 'boolean' },
    startsAt: dateTime,
    endsAt: dateTime,
    startDate: { type: ['string', 'null'] },
    endDate: { type: ['string', 'null'] },
    timeZone: { type: 'string' },
    status: { type: 'string', enum: ['hidden', 'published', 'cancelled'] },
    publishedAt: nullableDateTime,
    cancelledAt: nullableDateTime,
    session: sessionView,
    createdAt: dateTime,
    updatedAt: dateTime,
  },
} as const;

const dueDate = {
  type: 'object',
  required: ['activityId', 'course', 'title', 'dueAt', 'lateUntil'],
  additionalProperties: false,
  properties: { activityId: uuid, course: courseRef, title: { type: 'string' }, dueAt: dateTime, lateUntil: nullableDateTime },
} as const;

export const calendarSchema = {
  type: 'object',
  required: ['timeZone', 'from', 'to', 'events', 'dueDates'],
  additionalProperties: false,
  properties: {
    timeZone: { type: 'string' },
    from: dateTime,
    to: dateTime,
    events: { type: 'array', items: eventSchema },
    dueDates: { type: 'array', items: dueDate },
  },
} as const;

export const calendarQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { from: instant, to: instant, courseId: uuid },
} as const;

export const eventListSchema = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: { items: { type: 'array', items: eventSchema } },
} as const;
