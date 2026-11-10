/**
 * Applies the versioned migrations to a temporary PostgreSQL database and
 * exercises key constraints. Skipped unless TEST_DATABASE_URL points at a
 * local server whose role may CREATE DATABASE. The temporary database is
 * created and dropped by the test; existing databases are never modified.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { count, eq } from 'drizzle-orm';
import {
  activities,
  auditLog,
  courses,
  enrollments,
  sections,
  terms,
  users,
} from '../../src/db/schema/index.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PG = {
  invalidEnum: '22P02',
  foreignKey: '23503',
  unique: '23505',
  check: '23514',
  restrict: '23001',
} as const;

function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  while (current && typeof current === 'object') {
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (err) => {
    assert.equal(pgErrorCode(err), code);
    return true;
  });
}

function first<T>(rows: T[]): T {
  const row = rows[0];
  assert.ok(row, 'expected a returned row');
  return row;
}

describe('database migrations (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let seq = 0;

  const db = () => database.db;
  const raw = (sql: string, params: unknown[] = []) => database.pool.query(sql, params);

  const createUser = async (overrides: Partial<typeof users.$inferInsert> = {}) =>
    first(
      await db()
        .insert(users)
        .values({ email: `user${++seq}@example.edu.pe`, givenName: 'Ana', familyName: 'Quispe', ...overrides })
        .returning(),
    );
  const createTerm = async () =>
    first(
      await db()
        .insert(terms)
        .values({ code: `T${++seq}`, name: 'Term', academicYear: 2026, startsOn: '2026-08-17', endsOn: '2026-12-11' })
        .returning(),
    );
  const createCourse = async (termId: string, code = `C${++seq}`) =>
    first(await db().insert(courses).values({ termId, code, title: 'Matemática I' }).returning());

  before(async () => {
    database = await createTestDatabase();
  });

  after(async () => {
    await database?.drop();
  });

  it('creates the foundational and authentication tables', async () => {
    const { rows } = await raw(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    assert.deepEqual(
      rows.map((r) => r.table_name),
      [
        'account_invitations',
        'activities',
        'activity_completions',
        'assignment_criterion_scores',
        'assignment_submissions',
        'audit_log',
        'course_documents',
        'course_grading_policies',
        'course_template_sections',
        'course_template_versions',
        'course_templates',
        'courses',
        'document_summaries',
        'enrollments',
        'grade_categories',
        'grade_category_activities',
        'grades',
        'program_managers',
        'programs',
        'quiz_attempt_answers',
        'quiz_attempts',
        'quiz_questions',
        'resource_folders',
        'section_prerequisites',
        'sections',
        'sessions',
        'terms',
        'tutor_usage',
        'user_credentials',
        'users',
      ],
    );
  });

  it('enforces case-insensitive unique emails', async () => {
    await createUser({ email: 'Maria.Huaman@example.edu.pe' });
    await rejectsWith(createUser({ email: 'maria.huaman@EXAMPLE.edu.pe' }), PG.unique);
  });

  it('keeps administrator system-level only', async () => {
    const admin = await createUser({ systemRole: 'administrator' });
    assert.equal(admin.systemRole, 'administrator');
    assert.equal((await createUser()).systemRole, 'user');

    const course = await createCourse((await createTerm()).id);
    await rejectsWith(
      raw(`INSERT INTO enrollments (course_id, user_id, role) VALUES ($1, $2, 'administrator')`, [course.id, admin.id]),
      PG.invalidEnum,
    );
    await rejectsWith(
      raw(`INSERT INTO users (email, given_name, family_name, system_role) VALUES ('x@example.edu.pe', 'X', 'Y', 'student')`),
      PG.invalidEnum,
    );
  });

  it('allows one course-specific role per user per course', async () => {
    const user = await createUser();
    const term = await createTerm();
    const courseA = await createCourse(term.id);
    const courseB = await createCourse(term.id);

    await db().insert(enrollments).values({ courseId: courseA.id, userId: user.id, role: 'student' });
    await rejectsWith(
      db().insert(enrollments).values({ courseId: courseA.id, userId: user.id, role: 'instructor' }),
      PG.unique,
    );
    const other = first(
      await db().insert(enrollments).values({ courseId: courseB.id, userId: user.id, role: 'instructor' }).returning(),
    );
    assert.equal(other.role, 'instructor');
    assert.equal(other.status, 'active');
  });

  it('rejects references to missing rows', async () => {
    const user = await createUser();
    await rejectsWith(
      db().insert(enrollments).values({ courseId: randomUUID(), userId: user.id, role: 'student' }),
      PG.foreignKey,
    );
    await rejectsWith(createCourse(randomUUID()), PG.foreignKey);
  });

  it('makes course codes unique per term and defaults status to draft', async () => {
    const term1 = await createTerm();
    const term2 = await createTerm();
    const course = await createCourse(term1.id, 'MAT101-A');
    assert.equal(course.status, 'draft');
    await rejectsWith(createCourse(term1.id, 'MAT101-A'), PG.unique);
    await createCourse(term2.id, 'MAT101-A');
    await rejectsWith(raw(`UPDATE courses SET status = 'deleted' WHERE id = $1`, [course.id]), PG.invalidEnum);
  });

  it('rejects terms that end before they start', async () => {
    await rejectsWith(
      db().insert(terms).values({ code: 'BAD', name: 'Bad', academicYear: 2026, startsOn: '2026-12-01', endsOn: '2026-08-01' }),
      PG.check,
    );
  });

  it('validates activity ordering and JSON configuration', async () => {
    const course = await createCourse((await createTerm()).id);
    const section = first(await db().insert(sections).values({ courseId: course.id, title: 'Unidad 1', position: 0 }).returning());
    assert.equal(section.isVisible, true);

    const activity = first(
      await db().insert(activities).values({ sectionId: section.id, type: 'quiz', title: 'Quiz 1', position: 0 }).returning(),
    );
    assert.deepEqual(activity.config, {});

    await rejectsWith(
      raw(`INSERT INTO activities (section_id, type, title, position, config) VALUES ($1, 'page', 'P', 1, '[]')`, [section.id]),
      PG.check,
    );
    await rejectsWith(
      db().insert(activities).values({ sectionId: section.id, type: 'page', title: 'P', position: -1 }),
      PG.check,
    );
  });

  it('cascades course deletion to sections, activities and enrollments', async () => {
    const user = await createUser();
    const course = await createCourse((await createTerm()).id);
    const section = first(await db().insert(sections).values({ courseId: course.id, title: 'S', position: 0 }).returning());
    await db().insert(activities).values({ sectionId: section.id, type: 'page', title: 'A', position: 0 });
    await db().insert(enrollments).values({ courseId: course.id, userId: user.id, role: 'student' });

    await db().delete(courses).where(eq(courses.id, course.id));

    const remaining = async (table: typeof sections | typeof enrollments) =>
      first(await db().select({ n: count() }).from(table).where(eq(table.courseId, course.id))).n;
    assert.equal(await remaining(sections), 0);
    assert.equal(await remaining(enrollments), 0);
    assert.equal(first(await db().select({ n: count() }).from(activities).where(eq(activities.sectionId, section.id))).n, 0);
  });

  it('prevents deleting users who hold enrollments', async () => {
    const user = await createUser();
    const course = await createCourse((await createTerm()).id);
    await db().insert(enrollments).values({ courseId: course.id, userId: user.id, role: 'student' });
    await rejectsWith(db().delete(users).where(eq(users.id, user.id)), PG.foreignKey);
  });

  it('keeps the audit log append-only', async () => {
    const actor = await createUser();
    const entry = first(
      await db()
        .insert(auditLog)
        .values({ actorUserId: actor.id, action: 'course.published', entityType: 'course', entityId: randomUUID() })
        .returning(),
    );
    assert.deepEqual(entry.metadata, {});

    await rejectsWith(db().update(auditLog).set({ action: 'tampered' }).where(eq(auditLog.id, entry.id)), PG.restrict);
    await rejectsWith(db().delete(auditLog).where(eq(auditLog.id, entry.id)), PG.restrict);
    await rejectsWith(raw('TRUNCATE audit_log'), PG.restrict);
    assert.equal(first(await db().select({ n: count() }).from(auditLog)).n, 1);
  });
});
