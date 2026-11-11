/**
 * Demo course forum (AP-027), posted through the real API as the synthetic accounts, in ITIL 4 Foundation:
 * a pinned, announced instructor topic; a student question with an instructor answer and a peer response;
 * and a locked discussion. Idempotent: every topic and reply carries a fixed `clientRequestId` derived from
 * its key, so re-running the seed returns the existing posts instead of adding new ones; pinning and locking
 * are no-ops when already applied. The API records the matching notifications itself.
 */
import type { Actor } from './api.js';
import type { Persona } from './content.js';
import { demoUuid } from './messaging.js';

type Tally = (kind: string, created: boolean) => void;
type Topic = { id: string };
type Post = { id: string; replies?: Post[] };
type ReplySpec = { key: string; from: Persona; body: string; replyTo?: string };
type TopicSpec = { key: string; from: Persona; title: string; body: string; announce?: boolean; pin?: boolean; lock?: boolean; replies: ReplySpec[] };

export const DEMO_FORUMS: { courseCode: string; topics: TopicSpec[] } = {
  courseCode: 'ITIL4-F-2026-2-A',
  topics: [
    {
      key: 'welcome',
      from: 'instructor',
      title: 'Bienvenida y normas del foro',
      body: 'Este foro es para dudas sobre los contenidos del curso. Abre un tema por pregunta, usa un título claro y responde con respeto. Las consultas personales (notas, plazos individuales) van por mensaje directo.',
      announce: true,
      pin: true,
      replies: [],
    },
    {
      key: 'value-chain-question',
      from: 'student',
      title: '¿Cuál es la diferencia entre la cadena de valor y un flujo de valor?',
      body: 'En la unidad 2 aparecen los dos términos y no me queda claro cuándo usar cada uno. ¿Alguien puede explicarlo con un ejemplo?',
      replies: [
        {
          key: 'value-chain-answer',
          from: 'instructor',
          body: 'La cadena de valor es el modelo con las seis actividades (planificar, mejorar, involucrar, diseñar y hacer la transición, obtener/construir, entregar y dar soporte). Un flujo de valor es la secuencia concreta de esas actividades para un caso, por ejemplo atender una solicitud de un usuario.',
        },
        {
          key: 'value-chain-peer',
          from: 'learnerA',
          replyTo: 'value-chain-answer',
          body: 'A mí me ayudó pensarlo así: la cadena de valor es el mapa y el flujo de valor es el recorrido que haces en ese mapa para un servicio específico.',
        },
      ],
    },
    {
      key: 'exam-format',
      from: 'learnerB',
      title: 'Formato del examen de práctica (cerrado)',
      body: '¿El examen de práctica tiene el mismo número de preguntas que el examen oficial?',
      lock: true,
      replies: [
        {
          key: 'exam-format-answer',
          from: 'ta',
          body: 'El examen de práctica del curso es más corto. Revisa la descripción del cuestionario para ver el número de preguntas y el tiempo disponible.',
        },
        {
          key: 'exam-format-close',
          from: 'instructor',
          body: 'Cierro este tema: la información está en la descripción del cuestionario. Para nuevas dudas, abre otro tema.',
        },
      ],
    },
  ],
};

export async function seedForums(actors: Record<Persona, Actor>, courseId: string, tally: Tally) {
  const moderator = actors.instructor;
  const listTopics = async () => (await moderator.call<{ items: Topic[] }>('GET', `/courses/${courseId}/forum/topics?limit=50`)).items.map((t) => t.id);
  const listPosts = async (topicId: string) => {
    const page = await moderator.call<{ items: Post[] }>('GET', `/forum/topics/${topicId}/posts?limit=50`);
    return page.items.flatMap((p) => [p.id, ...(p.replies ?? []).map((r) => r.id)]);
  };

  const known = new Set(await listTopics());
  for (const spec of DEMO_FORUMS.topics) {
    const topic = await actors[spec.from].call<Topic>('POST', `/courses/${courseId}/forum/topics`, {
      title: spec.title,
      body: spec.body,
      clientRequestId: demoUuid(`forum:${spec.key}`),
      ...(spec.announce ? { announce: true } : {}),
    });
    tally('forum topics', !known.has(topic.id));
    const existing = new Set(await listPosts(topic.id));
    const posted = new Map<string, string>();
    for (const reply of spec.replies) {
      const parentPostId = reply.replyTo ? posted.get(reply.replyTo) : undefined;
      const post = await actors[reply.from].call<Post>('POST', `/forum/topics/${topic.id}/posts`, {
        body: reply.body,
        clientRequestId: demoUuid(`forum:${spec.key}:${reply.key}`),
        ...(parentPostId ? { parentPostId } : {}),
      });
      posted.set(reply.key, post.id);
      tally('forum replies', !existing.has(post.id));
    }
    if (spec.pin) await moderator.call('POST', `/forum/topics/${topic.id}/moderation`, { action: 'pin' });
    if (spec.lock) await moderator.call('POST', `/forum/topics/${topic.id}/moderation`, { action: 'lock' });
  }
}
