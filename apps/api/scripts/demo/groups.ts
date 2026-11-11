/**
 * Demo student groups (AP-028), created through the real API as the synthetic accounts, in ITIL 4 Foundation:
 * two groups with different members, each with a private discussion the other group cannot see. Idempotent:
 * groups are found by name, adding a member twice is a no-op, and every topic and reply carries a fixed
 * `clientRequestId`, so re-running the seed adds nothing. The API records memberships, audit entries and
 * notifications itself.
 */
import type { Actor } from './api.js';
import type { Persona } from './content.js';
import { demoUuid } from './messaging.js';

type Tally = (kind: string, created: boolean) => void;
type Group = { id: string; name: string };
type Topic = { id: string };
type Post = { id: string; replies?: Post[] };
type GroupSpec = {
  key: string;
  name: string;
  description: string;
  members: Persona[];
  topic: { from: Persona; title: string; body: string; replies: Array<{ key: string; from: Persona; body: string }> };
};

export const DEMO_GROUPS: { courseCode: string; groups: GroupSpec[] } = {
  courseCode: 'ITIL4-F-2026-2-A',
  groups: [
    {
      key: 'alfa',
      name: 'Equipo Alfa',
      description: 'Caso práctico: mesa de servicio de una universidad.',
      members: ['student', 'learnerA'],
      topic: {
        from: 'student',
        title: 'Plan del caso práctico (Equipo Alfa)',
        body: 'Propongo dividir el caso así: yo describo el flujo de valor de una solicitud y tú mapeas las prácticas involucradas. ¿Te parece?',
        replies: [
          { key: 'peer', from: 'learnerA', body: 'De acuerdo. Empiezo por gestión de solicitudes de servicio y mesa de servicio; lo subo aquí el jueves.' },
          { key: 'instructor', from: 'instructor', body: 'Buen reparto. Incluyan cómo se mide el valor para el usuario en cada paso del flujo.' },
        ],
      },
    },
    {
      key: 'beta',
      name: 'Equipo Beta',
      description: 'Caso práctico: gestión de incidentes en un hospital.',
      members: ['learnerB'],
      topic: {
        from: 'learnerB',
        title: 'Borrador del Equipo Beta (privado)',
        body: 'Primer borrador del análisis de incidentes. Solo lo ve nuestro equipo y los docentes.',
        replies: [{ key: 'ta', from: 'ta', body: 'Revisa la diferencia entre incidente y problema antes de la entrega.' }],
      },
    },
  ],
};

export async function seedGroups(actors: Record<Persona, Actor>, courseId: string, tally: Tally) {
  const manager = actors.instructor;
  const existing = (await manager.call<{ items: Group[] }>('GET', `/courses/${courseId}/groups`)).items;
  for (const spec of DEMO_GROUPS.groups) {
    let group = existing.find((g) => g.name === spec.name);
    tally('student groups', !group);
    if (!group) group = (await manager.call<{ group: Group }>('POST', `/courses/${courseId}/groups`, { name: spec.name, description: spec.description })).group;
    const memberIds: string[] = [];
    for (const persona of spec.members) memberIds.push((await actors[persona].call<{ user: { id: string } }>('GET', '/me')).user.id);
    const added = await manager.call<{ added: number; alreadyMembers: number }>('POST', `/groups/${group.id}/members`, { userIds: memberIds });
    for (let i = 0; i < added.added; i++) tally('group memberships', true);
    for (let i = 0; i < added.alreadyMembers; i++) tally('group memberships', false);

    const known = new Set((await manager.call<{ items: Topic[] }>('GET', `/groups/${group.id}/topics?limit=50`)).items.map((t) => t.id));
    const topic = await actors[spec.topic.from].call<Topic>('POST', `/groups/${group.id}/topics`, {
      title: spec.topic.title,
      body: spec.topic.body,
      clientRequestId: demoUuid(`group:${spec.key}:topic`),
    });
    tally('group topics', !known.has(topic.id));
    const posts = (await manager.call<{ items: Post[] }>('GET', `/forum/topics/${topic.id}/posts?limit=50`)).items;
    const seen = new Set(posts.flatMap((p) => [p.id, ...(p.replies ?? []).map((r) => r.id)]));
    for (const reply of spec.topic.replies) {
      const post = await actors[reply.from].call<Post>('POST', `/forum/topics/${topic.id}/posts`, { body: reply.body, clientRequestId: demoUuid(`group:${spec.key}:${reply.key}`) });
      tally('group replies', !seen.has(post.id));
    }
  }
}
