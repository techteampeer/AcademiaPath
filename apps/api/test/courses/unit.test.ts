import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  COURSE_ROLE_PERMISSIONS,
  hasCoursePermission,
  UNPUBLISHED_VIEWER_ROLES,
  type CoursePermission,
} from '../../src/auth/authorization.js';
import { courseRoleEnum } from '../../src/db/schema/index.js';
import { ApiProblem } from '../../src/http/errors.js';
import { normalizeResourceUrl, normalizeSafeHttpUrl } from '../../src/content/urls.js';
import { gradeResponse, normalizeResponse } from '../../src/quizzes/grading.js';
import { assignmentFromInput, validateScores } from '../../src/assignments/model.js';
import { courseTotal, toScale20 } from '../../src/grading/scale.js';
import { buildQuestion, passed, selectQuestions, shuffle, validatePool } from '../../src/quizzes/model.js';
import { decodeCursor, encodeCursor, toPage } from '../../src/http/pagination.js';
import { hasCycle, isReadingType, summarize } from '../../src/progress/model.js';

describe('course role permissions', () => {
  it('grants exactly the documented permissions per role (default deny)', () => {
    const granted = (role: keyof typeof COURSE_ROLE_PERMISSIONS) => [...COURSE_ROLE_PERMISSIONS[role]].sort();
    const staff: CoursePermission[] = [
      'course.view',
      'course.viewUnpublished',
      'enrollments.viewAll',
      'sections.viewHidden',
      'content.viewUnapproved',
    ];
    const grader = ['grades.export', 'grades.grade', 'grades.view'];
    assert.deepEqual(granted('student'), ['assignment.submit', 'certificates.own', 'course.view', 'grades.viewOwn', 'progress.own', 'quiz.attempt', 'tutor.use']);
    // AP-023: non-editing instructors read and export the gradebook but neither release grades nor configure weights.
    // AP-024: non-editing instructors keep grading (documented) and only read certificates.
    assert.deepEqual(granted('non_editing_instructor'), [...staff, 'quiz.viewResults', ...grader, 'certificates.view', 'tutor.use', 'progress.viewAll'].sort());
    assert.deepEqual(
      granted('instructor'),
      [...staff, 'content.edit', 'content.submit', 'quiz.viewResults', ...grader, 'grades.release', 'grades.configure', 'certificates.view', 'certificates.manage', 'tutor.use', 'progress.viewAll'].sort(),
    );
    assert.equal(hasCoursePermission('non_editing_instructor', 'grades.release'), false);
    assert.equal(hasCoursePermission('non_editing_instructor', 'grades.configure'), false);
    assert.equal(hasCoursePermission('non_editing_instructor', 'certificates.manage'), false);
    assert.equal(hasCoursePermission('design_team', 'certificates.view'), false, 'the design team never sees student certificates');
    assert.deepEqual(granted('design_team'), [...staff, 'content.edit', 'content.submit', 'content.review'].sort());
    assert.equal(hasCoursePermission('design_team', 'quiz.attempt'), false, 'staff never take quizzes');
    assert.equal(hasCoursePermission('design_team', 'progress.viewAll'), false, 'the design team never reads student progress');
    assert.equal(hasCoursePermission('instructor', 'content.review'), false, 'instructors never approve');
    for (const permission of ['content.edit', 'content.submit', 'content.review'] as const) {
      assert.equal(hasCoursePermission('non_editing_instructor', permission), false);
      assert.equal(hasCoursePermission('student', permission), false);
    }
    assert.equal(hasCoursePermission('student', 'content.viewUnapproved'), false);
    assert.equal(hasCoursePermission('student', 'enrollments.viewAll'), false);
    assert.equal(hasCoursePermission(null, 'course.view'), false);
  });

  it('covers every course role and never lets students see unpublished courses', () => {
    assert.deepEqual(Object.keys(COURSE_ROLE_PERMISSIONS).sort(), [...courseRoleEnum.enumValues].sort());
    assert.ok(!UNPUBLISHED_VIEWER_ROLES.includes('student'));
    assert.deepEqual([...UNPUBLISHED_VIEWER_ROLES].sort(), ['design_team', 'instructor', 'non_editing_instructor']);
  });
});

describe('cursor pagination', () => {
  it('round-trips keyset cursors', () => {
    const id = randomUUID();
    assert.deepEqual(decodeCursor(encodeCursor('MAT101', id), 'string'), { key: 'MAT101', id });
    assert.deepEqual(decodeCursor(encodeCursor(3, id), 'number'), { key: 3, id });
    assert.equal(decodeCursor(undefined, 'string'), null);
  });

  it('rejects tampered or malformed cursors with INVALID_CURSOR', () => {
    const id = randomUUID();
    const isInvalidCursor = (error: unknown) =>
      error instanceof ApiProblem && error.status === 400 && error.code === 'INVALID_CURSOR';
    const badStringCursors = [
      'not-a-cursor',
      Buffer.from('{"a":1}').toString('base64url'),
      encodeCursor('MAT101', 'not-a-uuid'),
      Buffer.from(JSON.stringify(['a', id, 'extra'])).toString('base64url'),
    ];
    for (const cursor of badStringCursors) {
      assert.throws(() => decodeCursor(cursor, 'string'), isInvalidCursor);
    }
    assert.throws(() => decodeCursor(encodeCursor(1.5, id), 'number'), isInvalidCursor);
    assert.throws(() => decodeCursor(encodeCursor('MAT101', id), 'number'), isInvalidCursor);
  });

  it('returns nextCursor only when more rows exist', () => {
    const rows = [1, 2, 3].map((n) => ({ code: `C${n}`, id: randomUUID() }));
    const page = toPage(rows, 2, (row) => [row.code, row.id]);
    assert.equal(page.items.length, 2);
    assert.deepEqual(decodeCursor(page.nextCursor ?? undefined, 'string'), { key: 'C2', id: rows[1]?.id });
    assert.equal(toPage(rows.slice(0, 2), 2, (row) => [row.code, row.id]).nextCursor, null);
  });
});

describe('external URL safety', () => {
  it('accepts absolute http(s) URLs and normalizes them', () => {
    assert.equal(normalizeSafeHttpUrl('https://www.axelos.com/itil'), 'https://www.axelos.com/itil');
    assert.equal(normalizeSafeHttpUrl('  HTTP://Example.edu/path?q=1#x  '), 'http://example.edu/path?q=1#x');
  });

  it('rejects other schemes, relative URLs, credentials and malformed input', () => {
    for (const value of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'ftp://example.com/file',
      '/relative/path',
      '//example.com/protocol-relative',
      'example.com',
      'https://user:secret@example.com/',
      'https://exa mple.com/',
      'https://example.com/\nnext',
      'http://',
      '',
      `https://example.com/${'a'.repeat(2048)}`,
    ]) {
      assert.equal(normalizeSafeHttpUrl(value), null, value.slice(0, 40));
    }
  });
});

describe('quiz grading (server-side)', () => {
  const question = { correctAnswer: { optionIds: ['a', 'c'] }, points: 3 };

  it('awards full points only for an exact match of the correct selection', () => {
    assert.deepEqual(gradeResponse(question, { optionIds: ['c', 'a'] }), { isCorrect: true, awardedPoints: 3 });
    assert.deepEqual(gradeResponse(question, { optionIds: ['a'] }), { isCorrect: false, awardedPoints: 0 }, 'partial selection');
    assert.deepEqual(gradeResponse(question, { optionIds: ['a', 'b', 'c'] }), { isCorrect: false, awardedPoints: 0 }, 'superset');
    assert.deepEqual(gradeResponse(question, { optionIds: [] }), { isCorrect: false, awardedPoints: 0 }, 'empty');
    assert.deepEqual(gradeResponse(question, null), { isCorrect: false, awardedPoints: 0 }, 'unanswered');
    assert.deepEqual(gradeResponse({ correctAnswer: { optionIds: ['true'] }, points: 1 }, { optionIds: ['true'] }), { isCorrect: true, awardedPoints: 1 });
    assert.deepEqual(gradeResponse({ correctAnswer: { optionIds: ['true'] }, points: 1 }, { optionIds: ['false'] }), { isCorrect: false, awardedPoints: 0 });
  });

  it('validates responses against the presented options', () => {
    const single = { type: 'single_choice' as const, options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] };
    assert.deepEqual(normalizeResponse(single, ['a', 'a']), { optionIds: ['a'] });
    assert.deepEqual(normalizeResponse(single, []), { optionIds: [] });
    assert.throws(() => normalizeResponse(single, ['a', 'b']), (e: unknown) => e instanceof ApiProblem && e.code === 'INVALID_ANSWER');
    assert.throws(() => normalizeResponse(single, ['zzz']), (e: unknown) => e instanceof ApiProblem && e.code === 'INVALID_ANSWER');
    assert.deepEqual(normalizeResponse({ ...single, type: 'multiple_choice' }, ['b', 'a']), { optionIds: ['b', 'a'] });
  });

  it('builds answer keys from instructor input and rejects inconsistent keys', () => {
    const single = buildQuestion({ type: 'single_choice', prompt: ' Q ', points: 2, options: [{ text: 'A', isCorrect: true }, { text: 'B', isCorrect: false }] });
    assert.equal(single.prompt, 'Q');
    assert.deepEqual(single.correctAnswer.optionIds, [single.options[0]!.id]);
    assert.ok(single.options.every((option) => !('isCorrect' in option)), 'options never carry correctness');
    const tf = buildQuestion({ type: 'true_false', prompt: 'T?', points: 1, correctAnswer: false });
    assert.deepEqual(tf.correctAnswer, { optionIds: ['false'] });
    const invalid = (input: Parameters<typeof buildQuestion>[0]) =>
      assert.throws(() => buildQuestion(input), (e: unknown) => e instanceof ApiProblem && e.code === 'INVALID_ANSWER_KEY');
    invalid({ type: 'single_choice', prompt: 'Q', points: 1, options: [{ text: 'A', isCorrect: true }, { text: 'B', isCorrect: true }] });
    invalid({ type: 'single_choice', prompt: 'Q', points: 1, options: [{ text: 'A', isCorrect: false }, { text: 'B', isCorrect: false }] });
    invalid({ type: 'multiple_choice', prompt: 'Q', points: 1, options: [{ text: 'A', isCorrect: false }, { text: 'B', isCorrect: false }] });
  });

  it('shuffles without losing or duplicating items', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const shuffled = shuffle(items);
    assert.deepEqual([...shuffled].sort((a, b) => a - b), items);
    assert.deepEqual(items, Array.from({ length: 20 }, (_, i) => i), 'input not mutated');
  });
});

describe('0–20 grade scale (server-side)', () => {
  it('converts points to the 0–20 scale, rounding half up to one decimal', () => {
    assert.equal(toScale20(6, 6), 20);
    assert.equal(toScale20(0, 6), 0);
    assert.equal(toScale20(7, 9), 15.6, '15.555… rounds up');
    assert.equal(toScale20(1, 3), 6.7, '6.666… rounds up');
    assert.equal(toScale20(2, 3), 13.3, '13.333… rounds down');
    assert.equal(toScale20(1, 80), 0.3, 'exact half (0.25) rounds up, not to even');
    assert.equal(toScale20(13, 40), 6.5);
    assert.equal(toScale20(11, 20), 11);
    for (const [points, max] of [[-1, 5], [6, 5], [1.5, 5], [0, 0]] as const) {
      assert.throws(() => toScale20(points, max), RangeError);
    }
  });

  it('sums points before converting the course total (no compounded rounding)', () => {
    assert.deepEqual(courseTotal([{ points: 7, maxPoints: 9 }, { points: 1, maxPoints: 3 }]), { points: 8, maxPoints: 12, grade20: 13.3, gradedItems: 2 });
    assert.deepEqual(courseTotal([]), { points: 0, maxPoints: 0, grade20: null, gradedItems: 0 });
  });
});

describe('assignment rules (server-side)', () => {
  const base = { title: 'Essay', instructions: 'Write.', dueAt: '2026-11-20T23:59:00-05:00', rubric: [{ title: ' Content ', maxPoints: 8 }, { title: 'Style', description: ' clear ', maxPoints: 4 }] };

  it('normalizes dates and generates rubric criterion ids', () => {
    const settings = assignmentFromInput({ ...base, lateUntil: '2026-11-22T23:59:00-05:00' });
    assert.equal(settings.dueAt, '2026-11-21T04:59:00.000Z');
    assert.equal(settings.lateUntil, '2026-11-23T04:59:00.000Z');
    assert.deepEqual(settings.rubric.map((c) => [c.title, c.description, c.maxPoints]), [['Content', null, 8], ['Style', 'clear', 4]]);
    assert.ok(settings.rubric.every((c) => /^[0-9a-f-]{36}$/.test(c.id)));
  });

  it('rejects late windows that end before the due date or more than 30 days after it', () => {
    const invalid = (lateUntil: string) =>
      assert.throws(() => assignmentFromInput({ ...base, lateUntil }), (e: unknown) => e instanceof ApiProblem && e.code === 'INVALID_DUE_DATE');
    invalid('2026-11-20T23:59:00-05:00');
    invalid('2026-11-19T00:00:00Z');
    invalid('2026-12-31T00:00:00Z');
  });

  it('accepts only complete rubric scores within each criterion maximum', () => {
    const { rubric } = assignmentFromInput(base);
    const content = rubric[0]!;
    const style = rubric[1]!;
    assert.deepEqual(
      validateScores(rubric, [{ criterionId: style.id, points: 4 }, { criterionId: content.id, points: 0 }]).map((s) => s.points),
      [0, 4],
    );
    const invalid = (scores: Array<{ criterionId: string; points: number }>) =>
      assert.throws(() => validateScores(rubric, scores), (e: unknown) => e instanceof ApiProblem && e.code === 'INVALID_RUBRIC_SCORES');
    invalid([{ criterionId: content.id, points: 9 }, { criterionId: style.id, points: 1 }]);
    invalid([{ criterionId: content.id, points: 1 }]);
    invalid([{ criterionId: content.id, points: 1 }, { criterionId: content.id, points: 1 }]);
    invalid([{ criterionId: content.id, points: 1 }, { criterionId: '00000000-0000-4000-8000-000000000000', points: 1 }]);
  });
});

describe('learning progress rules', () => {
  it('rounds percentages down and reports no percentage without eligible activities', () => {
    assert.deepEqual(summarize(0, 0), { completedCount: 0, totalCount: 0, percent: null, state: 'no_activities' });
    assert.deepEqual(summarize(0, 8), { completedCount: 0, totalCount: 8, percent: 0, state: 'not_started' });
    assert.deepEqual(summarize(7, 8), { completedCount: 7, totalCount: 8, percent: 87, state: 'in_progress' });
    assert.deepEqual(summarize(2, 3), { completedCount: 2, totalCount: 3, percent: 66, state: 'in_progress' });
    assert.deepEqual(summarize(3, 3), { completedCount: 3, totalCount: 3, percent: 100, state: 'completed' });
  });

  it('only reading activities can be marked by hand', () => {
    assert.deepEqual(['page', 'link', 'file', 'quiz', 'assignment', 'scorm', 'lti'].filter(isReadingType), ['page', 'link', 'file']);
  });

  it('detects prerequisite cycles of any length, and accepts chains and diamonds', () => {
    const edge = (sectionId: string, requiredSectionId: string) => ({ sectionId, requiredSectionId });
    assert.equal(hasCycle([]), false);
    assert.equal(hasCycle([edge('b', 'a'), edge('c', 'b')]), false);
    assert.equal(hasCycle([edge('b', 'a'), edge('c', 'a'), edge('d', 'b'), edge('d', 'c')]), false);
    assert.equal(hasCycle([edge('a', 'a')]), true);
    assert.equal(hasCycle([edge('a', 'b'), edge('b', 'a')]), true);
    assert.equal(hasCycle([edge('b', 'a'), edge('c', 'b'), edge('a', 'c')]), true);
  });
});

describe('learning resource URLs (AP-021)', () => {
  it('accepts https URLs on domain names and normalizes them', () => {
    assert.equal(normalizeResourceUrl('  https://www.YouTube.com/watch?v=abc#t=10 '), 'https://www.youtube.com/watch?v=abc#t=10');
    assert.equal(normalizeResourceUrl('https://phet.colorado.edu/en/simulations/projectile-motion'), 'https://phet.colorado.edu/en/simulations/projectile-motion');
  });

  it('rejects dangerous schemes, plain http, credentials, IP literals, localhost and single-label hosts', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'blob:https://example.edu/uuid',
      'file:///etc/passwd',
      'http://example.edu/',
      'https://user:pass@example.edu/',
      'https://10.0.0.1/',
      'https://[2001:db8::1]/',
      'https://localhost/',
      'https://app.localhost/',
      'https://intranet/',
      '//example.edu/',
      'https://example.edu/\nx',
    ]) {
      assert.equal(normalizeResourceUrl(value.replace('\\n', '\n')), null, value);
    }
  });
});

describe('assessment controls (AP-022)', () => {
  const questions = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, points: 2 }));

  it('draws a uniformly random subset of the requested size, in course order unless shuffled', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const drawn = selectQuestions({ questionsPerAttempt: 3, shuffleQuestions: false }, questions);
      assert.equal(drawn.length, 3);
      assert.equal(new Set(drawn).size, 3);
      assert.deepEqual(drawn, [...drawn].sort((a, b) => a.id.localeCompare(b.id)), 'course order kept');
      drawn.forEach((q) => seen.add(q.id));
    }
    assert.equal(seen.size, 5, 'every question can be drawn');
    assert.deepEqual(selectQuestions({ questionsPerAttempt: null, shuffleQuestions: false }, questions), questions, 'default: every question, in order');
    assert.equal(selectQuestions({ questionsPerAttempt: 9, shuffleQuestions: true }, questions).length, 5);
  });

  it('rejects pools that are too small or mix point values', () => {
    assert.doesNotThrow(() => validatePool({ questionsPerAttempt: null }, [{ points: 1 }, { points: 3 }]));
    assert.doesNotThrow(() => validatePool({ questionsPerAttempt: 5 }, questions));
    assert.throws(() => validatePool({ questionsPerAttempt: 6 }, questions), /QUIZ_POOL_TOO_SMALL|draws 6/);
    assert.throws(() => validatePool({ questionsPerAttempt: 2 }, [{ points: 1 }, { points: 2 }, { points: 1 }]), /same points/);
  });

  it('computes passing status exactly at the threshold and only when one is set', () => {
    assert.equal(passed(3, 5, 60), true);
    assert.equal(passed(59, 100, 60), false);
    assert.equal(passed(2, 3, 67), false, '66.67% is below 67%');
    assert.equal(passed(4, 6, null), null);
  });
});
