/**
 * DEVELOPMENT ONLY — AP-025 demo announcements and calendar events, created through the real API as the
 * ITIL instructor and the administrator. Idempotent: everything is found by title before it is created.
 * Dates are relative to when the seed runs (re-seeding a fresh database regenerates upcoming dates):
 * the scheduled announcement publishes three days later at 08:00 Lima time, and the review session is two
 * days later from 19:00 to 20:30 Lima time. The institutional event is the real end of term 2026-2.
 */
import { dateIn } from '../../src/calendar/time.js';
import type { Actor } from './api.js';

const ZONE = 'America/Lima';
const DAY = 86_400_000;
type Ref = { id: string; title: string };
type Tally = (kind: string, created: boolean) => void;

export const DEMO_COMMUNICATIONS = {
  courseCode: 'ITIL4-F-2026-2-A',
  welcome: {
    title: 'Bienvenidos al módulo de práctica',
    body: 'Esta semana practicamos con el cuestionario del módulo 3 y la tarea sobre la cadena de valor.\nRevisen la lectura "Incident and problem management" antes de la sesión de repaso.',
  },
  scheduled: {
    title: 'Recordatorio: entrega de la tarea',
    body: 'Recuerden entregar la tarea "Mapping a service to the value chain" antes de la fecha límite. Las entregas tardías no se aceptan.',
  },
  institution: {
    title: 'Cierre del semestre 2026-2',
    body: 'El semestre 2026-2 termina el 11 de diciembre. Las notas finales se publican en cada curso.',
  },
  courseEvent: { title: 'Sesión de repaso en vivo: ITIL 4', description: 'Repaso de los módulos 1 a 3 y preguntas sobre la tarea.' },
  institutionEvent: { title: 'Fin del semestre 2026-2', date: '2026-12-11' },
} as const;

export async function seedCommunications(actors: { instructor: Actor; admin: Actor }, courseId: string, tally: Tally, now = new Date()) {
  const { instructor, admin } = actors;
  const d = DEMO_COMMUNICATIONS;

  const courseAnnouncements = await instructor.listAll<Ref>(`/courses/${courseId}/announcements?status=all`);
  const ensureAnnouncement = async (actor: Actor, existing: Ref[], create: string, spec: { title: string; body: string }, publish: object, pinned = false) => {
    if (existing.some((item) => item.title === spec.title)) return tally('announcements', false);
    const created = await actor.call<Ref>('POST', create, { title: spec.title, body: spec.body, pinned });
    await actor.call('POST', `/announcements/${created.id}/publish`, publish);
    tally('announcements', true);
  };
  await ensureAnnouncement(instructor, courseAnnouncements, `/courses/${courseId}/announcements`, d.welcome, {}, true);
  const scheduledDate = dateIn(new Date(now.getTime() + 3 * DAY), ZONE);
  await ensureAnnouncement(instructor, courseAnnouncements, `/courses/${courseId}/announcements`, d.scheduled, { publishAt: `${scheduledDate}T08:00:00-05:00` });
  await ensureAnnouncement(admin, await admin.listAll<Ref>('/announcements?status=all'), '/announcements', d.institution, {});

  // A window around the seed date, wide enough to find the demo events on a re-run.
  const range = `from=${new Date(now.getTime() - 30 * DAY).toISOString()}&to=${new Date(now.getTime() + 360 * DAY).toISOString()}`;
  const courseEvents = (await instructor.call<{ events: Ref[] }>('GET', `/courses/${courseId}/calendar?${range}`)).events;
  if (courseEvents.some((event) => event.title === d.courseEvent.title)) tally('calendar events', false);
  else {
    const date = dateIn(new Date(now.getTime() + 2 * DAY), ZONE);
    await instructor.call('POST', `/courses/${courseId}/calendar/events`, {
      ...d.courseEvent,
      allDay: false,
      startsAt: `${date}T19:00:00-05:00`,
      endsAt: `${date}T20:30:00-05:00`,
      timeZone: ZONE,
      status: 'published',
    });
    tally('calendar events', true);
  }
  const institutionEvents = (await admin.call<{ items: Ref[] }>('GET', `/calendar/events?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z`)).items;
  if (institutionEvents.some((event) => event.title === d.institutionEvent.title)) tally('calendar events', false);
  else {
    await admin.call('POST', '/calendar/events', {
      title: d.institutionEvent.title,
      description: 'Último día del semestre académico 2026-2.',
      allDay: true,
      startDate: d.institutionEvent.date,
      endDate: d.institutionEvent.date,
      timeZone: ZONE,
      status: 'published',
    });
    tally('calendar events', true);
  }
}
