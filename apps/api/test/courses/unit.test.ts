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
import { normalizeSafeHttpUrl } from '../../src/content/urls.js';
import { gradeResponse, normalizeResponse } from '../../src/quizzes/grading.js';
import { buildQuestion, shuffle } from '../../src/quizzes/model.js';
import { decodeCursor, encodeCursor, toPage } from '../../src/http/pagination.js';

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
    assert.deepEqual(granted('student'), ['course.view', 'quiz.attempt']);
    assert.deepEqual(granted('non_editing_instructor'), [...staff, 'quiz.viewResults'].sort());
    assert.deepEqual(granted('instructor'), [...staff, 'content.edit', 'content.submit', 'quiz.viewResults'].sort());
    assert.deepEqual(granted('design_team'), [...staff, 'content.edit', 'content.submit', 'content.review'].sort());
    assert.equal(hasCoursePermission('design_team', 'quiz.attempt'), false, 'staff never take quizzes');
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
