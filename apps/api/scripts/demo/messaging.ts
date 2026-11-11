/**
 * Demo conversations (AP-026), sent through the real API as the synthetic accounts, in ITIL 4 Foundation.
 * Idempotent: conversations are opened with "open or return", and every message carries a fixed
 * `clientMessageId` derived from its key, so re-running the seed returns the existing messages instead of
 * adding new ones. The API records the matching in-app notifications itself.
 */
import { createHash } from 'node:crypto';
import type { Actor } from './api.js';
import type { Persona } from './content.js';

type Tally = (kind: string, created: boolean) => void;
type Conversation = { id: string };
type Contact = { id: string; name: string };

/** A stable UUID (version 5 layout) for a seed key: the same key always gives the same id. */
export function demoUuid(key: string): string {
  const hash = createHash('sha1').update(`academiapath-demo:${key}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const DEMO_MESSAGING = {
  courseCode: 'ITIL4-F-2026-2-A',
  direct: [
    {
      key: 'student-instructor',
      from: 'student' as Persona,
      to: 'instructor' as Persona,
      messages: [
        { from: 'student' as Persona, body: 'Profesor, ¿la tarea "Mapping a service to the value chain" debe incluir un diagrama?' },
        { from: 'instructor' as Persona, body: 'Sí: incluye un diagrama simple de la cadena de valor y explica cada actividad en dos o tres líneas.' },
      ],
    },
    {
      key: 'learnerB-ta',
      from: 'learnerB' as Persona,
      to: 'ta' as Persona,
      messages: [
        { from: 'learnerB' as Persona, body: '¿Cuándo estará lista la nota de mi tarea?' },
        { from: 'ta' as Persona, body: 'La estoy revisando esta semana; la nota aparecerá cuando el instructor la publique.' },
      ],
    },
  ],
  course: [
    { from: 'instructor' as Persona, body: 'Bienvenidos al chat del curso. Usen este espacio para dudas generales; las consultas personales, por mensaje directo.' },
    { from: 'learnerA' as Persona, body: '¡Gracias! ¿La sesión de repaso en vivo quedará grabada?' },
    { from: 'instructor' as Persona, body: 'Sí, compartiremos la grabación en el curso al día siguiente.' },
  ],
} as const;

export async function seedMessaging(actors: Record<Persona, Actor>, courseId: string, tally: Tally) {
  const d = DEMO_MESSAGING;
  const send = async (actor: Actor, conversationId: string, key: string, body: string) => {
    // 201: new message; 200: the message of an earlier run (same clientMessageId).
    const before = await actor.call<{ items: Array<{ id: string }> }>('GET', `/conversations/${conversationId}/messages?limit=100`);
    const sent = await actor.call<{ id: string }>('POST', `/conversations/${conversationId}/messages`, { body, clientMessageId: demoUuid(key) });
    tally('messages', !before.items.some((m) => m.id === sent.id));
  };

  for (const thread of d.direct) {
    const opener = actors[thread.from];
    const contacts = (await opener.call<{ contacts: Contact[] }>('GET', `/courses/${courseId}/messaging`)).contacts;
    const recipientId = (await actors[thread.to].call<{ user: { id: string } }>('GET', '/me')).user.id;
    const target = contacts.find((c) => c.id === recipientId);
    if (!target) throw new Error(`Demo messaging: ${thread.to} is not a contact of ${thread.from} in ${d.courseCode}.`);
    const existing = (await opener.call<{ directConversations: Array<Conversation & { counterpart: { id: string } | null }> }>('GET', `/courses/${courseId}/messaging`)).directConversations;
    const conversation = existing.find((c) => c.counterpart?.id === target.id) ?? (await opener.call<Conversation>('POST', `/courses/${courseId}/conversations`, { recipientUserId: target.id }));
    tally('conversations', !existing.some((c) => c.id === conversation.id));
    for (const [index, message] of thread.messages.entries()) await send(actors[message.from], conversation.id, `${thread.key}:${index}`, message.body);
  }

  const existingCourse = (await actors.instructor.call<{ courseConversation: Conversation | null }>('GET', `/courses/${courseId}/messaging`)).courseConversation;
  const courseConversation = existingCourse ?? (await actors.instructor.call<Conversation>('POST', `/courses/${courseId}/course-conversation`));
  tally('conversations', !existingCourse);
  for (const [index, message] of d.course.entries()) await send(actors[message.from], courseConversation.id, `course:${index}`, message.body);
}
