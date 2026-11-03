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
    assert.deepEqual(granted('student'), ['course.view']);
    assert.deepEqual(granted('non_editing_instructor'), [...staff].sort());
    assert.deepEqual(granted('instructor'), [...staff, 'content.edit', 'content.submit'].sort());
    assert.deepEqual(granted('design_team'), [...staff, 'content.edit', 'content.submit', 'content.review'].sort());
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
