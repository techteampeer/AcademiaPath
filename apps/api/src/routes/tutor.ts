import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { canAsCourseRole, getCourseAccess, hasCoursePermission, type CourseAccess } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import type { Database } from '../db/client.js';
import { enrollments, tutorUsage } from '../db/schema/index.js';
import { ApiProblem, sendError } from '../http/errors.js';
import { mockTutorProvider, type TutorLanguage, type TutorProvider } from '../tutor/provider.js';
import { firstApprovedLessons, openingSources, searchApprovedLessons, selectSources, type TutorScope, type TutorSource } from '../tutor/retrieval.js';
import { searchTerms } from '../tutor/text.js';
import {
  tutorMessageResponseSchema,
  tutorMessageSchema,
  tutorParamsSchema,
  tutorPracticeResponseSchema,
  tutorPracticeSchema,
  tutorUsageResponseSchema,
} from './tutor-schemas.js';

type Params = { id: string };
type Executor = Pick<Database, 'select' | 'insert'>;
type Kind = 'message' | 'practice';

const notFound = (what: string) => new ApiProblem(404, 'NOT_FOUND', `${what} not found.`);

export const tutorRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app;
  // Only the local mock provider exists; no external inference service is ever called.
  const provider: TutorProvider = mockTutorProvider;
  const { max: limit, windowMinutes } = config.tutorRateLimit;
  const authenticated = { preValidation: [app.requireAuth] };
  const authenticatedWrite = { preValidation: [app.requireAuth, app.requireCsrf] };

  /**
   * Students, instructors and non-editing instructors of this course (role-only: administrators
   * and the design team are not granted the tutor). Students only reach published courses.
   */
  async function tutorAccess(request: FastifyRequest, courseId: string): Promise<CourseAccess> {
    const access = await getCourseAccess(db, getAuth(request).user, courseId);
    if (!access) throw notFound('Course');
    if (!canAsCourseRole(access, 'tutor.use')) {
      throw new ApiProblem(403, 'FORBIDDEN', 'The tutor is available to students and instructors of this course.');
    }
    return access;
  }

  const scopeOf = (access: CourseAccess): TutorScope => ({
    courseId: access.course.id,
    // Staff roles may read approved lessons in hidden sections; students never do.
    includeHidden: hasCoursePermission(access.viewerRole, 'sections.viewHidden'),
  });

  const windowFilter = (courseId: string, userId: string) =>
    and(
      eq(tutorUsage.courseId, courseId),
      eq(tutorUsage.userId, userId),
      sql`${tutorUsage.createdAt} > now() - make_interval(mins => ${windowMinutes})`,
    );

  async function usedInWindow(executor: Pick<Database, 'select'>, courseId: string, userId: string) {
    const [row] = await executor
      .select({
        used: count(),
        retryAfter: sql<number>`ceil(extract(epoch from (min(${tutorUsage.createdAt}) + make_interval(mins => ${windowMinutes}) - now())))`.mapWith(Number),
      })
      .from(tutorUsage)
      .where(windowFilter(courseId, userId));
    return { used: row?.used ?? 0, retryAfter: Math.max(1, row?.retryAfter ?? 1) };
  }

  /**
   * Runs one tutor request: serializes per user and course (enrollment row lock), enforces the
   * window limit, then records the outcome and cited activities only (never the question text).
   */
  async function runTutorRequest<T>(
    access: CourseAccess,
    userId: string,
    kind: Kind,
    language: TutorLanguage,
    work: (tx: Executor) => Promise<{ sources: TutorSource[]; result: T }>,
  ) {
    return db.transaction(async (tx) => {
      const [enrollment] = await tx
        .select({ id: enrollments.id })
        .from(enrollments)
        .where(and(eq(enrollments.courseId, access.course.id), eq(enrollments.userId, userId), eq(enrollments.status, 'active')))
        .for('update');
      if (!enrollment) throw notFound('Course');
      const window = await usedInWindow(tx, access.course.id, userId);
      if (window.used >= limit) return { limited: true as const, retryAfter: window.retryAfter };
      const { sources, result } = await work(tx);
      await tx.insert(tutorUsage).values({
        courseId: access.course.id,
        userId,
        enrollmentId: enrollment.id,
        kind,
        language,
        providerMode: provider.mode,
        outcome: sources.length ? 'grounded' : 'insufficient_material',
        sourceActivityIds: sources.map((source) => source.activityId),
      });
      return { limited: false as const, result, usage: { limit, windowMinutes, usedInWindow: window.used + 1 } };
    });
  }

  const citationOf = (source: TutorSource, ref: number, language: TutorLanguage) => ({
    ref,
    activityId: source.activityId,
    sectionId: source.sectionId,
    title: source.title,
    excerpt: source.excerpt,
    sourceLanguage: source.sourceLanguage,
    matchesRequestedLanguage: source.sourceLanguage === language,
  });
  const providerSources = (sources: TutorSource[]) =>
    sources.map((source, index) => ({ ref: index + 1, title: source.title, excerpt: source.excerpt, sourceLanguage: source.sourceLanguage, keyTerms: source.keyTerms }));
  const providerInfo = (language: TutorLanguage) => ({ mode: provider.mode, label: provider.label(language) });

  app.post<{ Params: Params; Body: { question: string; language: TutorLanguage } }>(
    '/courses/:id/tutor/messages',
    { ...authenticatedWrite, schema: { params: tutorParamsSchema, body: tutorMessageSchema, response: { 200: tutorMessageResponseSchema } } },
    async (request, reply) => {
      const access = await tutorAccess(request, request.params.id);
      const { user } = getAuth(request);
      const { question, language } = request.body;
      const outcome = await runTutorRequest(access, user.id, 'message', language, async (tx) => {
        const terms = searchTerms(question);
        const sources = selectSources(await searchApprovedLessons(tx, scopeOf(access), terms), terms);
        // Provider input: the question and numbered approved excerpts only; no names, emails or ids.
        const text = provider.answer({ question, language, sources: providerSources(sources) });
        return { sources, result: { text, citations: sources.map((source, index) => citationOf(source, index + 1, language)) } };
      });
      if (outcome.limited) {
        reply.header('retry-after', String(outcome.retryAfter));
        return sendError(reply, 429, 'RATE_LIMITED', 'Too many tutor requests. Try again later.');
      }
      return {
        provider: providerInfo(language),
        language,
        grounding: outcome.result.citations.length ? 'grounded' : 'insufficient_material',
        ...outcome.result,
        usage: outcome.usage,
      };
    },
  );

  app.post<{ Params: Params; Body: { language: TutorLanguage; topic?: string } }>(
    '/courses/:id/tutor/practice',
    { ...authenticatedWrite, schema: { params: tutorParamsSchema, body: tutorPracticeSchema, response: { 200: tutorPracticeResponseSchema } } },
    async (request, reply) => {
      const access = await tutorAccess(request, request.params.id);
      const { user } = getAuth(request);
      const { language } = request.body;
      const topic = request.body.topic?.trim() || null;
      const outcome = await runTutorRequest(access, user.id, 'practice', language, async (tx) => {
        let sources: TutorSource[];
        if (topic) {
          const terms = searchTerms(topic);
          sources = selectSources(await searchApprovedLessons(tx, scopeOf(access), terms), terms);
        } else {
          sources = openingSources(await firstApprovedLessons(tx, scopeOf(access)));
        }
        // A prompt may only cite a source that was actually retrieved; anything else is dropped.
        const prompts = provider
          .practice({ topic, language, sources: providerSources(sources) })
          .filter((prompt) => Number.isInteger(prompt.ref) && prompt.ref >= 1 && prompt.ref <= sources.length);
        const cited = new Set(prompts.map((prompt) => prompt.ref));
        // Only sources a prompt actually cites are recorded and returned.
        const used = sources.filter((_, index) => cited.has(index + 1));
        return {
          sources: used,
          result: prompts.map((prompt) => ({ ...prompt, citation: citationOf(sources[prompt.ref - 1]!, prompt.ref, language) })),
        };
      });
      if (outcome.limited) {
        reply.header('retry-after', String(outcome.retryAfter));
        return sendError(reply, 429, 'RATE_LIMITED', 'Too many tutor requests. Try again later.');
      }
      return {
        provider: providerInfo(language),
        language,
        grounding: outcome.result.length ? 'grounded' : 'insufficient_material',
        prompts: outcome.result,
        usage: outcome.usage,
      };
    },
  );

  app.get<{ Params: Params }>(
    '/courses/:id/tutor/usage',
    { ...authenticated, schema: { params: tutorParamsSchema, response: { 200: tutorUsageResponseSchema } } },
    async (request) => {
      const access = await tutorAccess(request, request.params.id);
      const { user } = getAuth(request);
      // Only the caller's own records in this course.
      const own = and(eq(tutorUsage.courseId, access.course.id), eq(tutorUsage.userId, user.id));
      const window = await usedInWindow(db, access.course.id, user.id);
      const [total] = await db.select({ n: count() }).from(tutorUsage).where(own);
      const items = await db
        .select({
          id: tutorUsage.id,
          kind: tutorUsage.kind,
          language: tutorUsage.language,
          outcome: tutorUsage.outcome,
          providerMode: tutorUsage.providerMode,
          sourceActivityIds: tutorUsage.sourceActivityIds,
          createdAt: tutorUsage.createdAt,
        })
        .from(tutorUsage)
        .where(own)
        .orderBy(desc(tutorUsage.createdAt), desc(tutorUsage.id))
        .limit(20);
      return { limit, windowMinutes, usedInWindow: window.used, totalRequests: total?.n ?? 0, items };
    },
  );
};
