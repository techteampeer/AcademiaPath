import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../src/db/schema/index.js';

const tables: PgTable[] = [
  schema.users,
  schema.programs,
  schema.terms,
  schema.courseTemplates,
  schema.courses,
  schema.enrollments,
  schema.sections,
  schema.activities,
  schema.auditLog,
];
const configs = tables.map((table) => getTableConfig(table));
const configOf = (name: string) => {
  const config = configs.find((c) => c.name === name);
  assert.ok(config, `missing table ${name}`);
  return config;
};

describe('database schema (static checks)', () => {
  it('defines the nine foundational tables', () => {
    assert.deepEqual(
      configs.map((c) => c.name).sort(),
      [
        'activities',
        'audit_log',
        'course_templates',
        'courses',
        'enrollments',
        'programs',
        'sections',
        'terms',
        'users',
      ],
    );
  });

  it('uses database-generated UUID primary keys', () => {
    for (const config of configs) {
      const id = config.columns.find((c) => c.name === 'id');
      assert.ok(id, `${config.name}.id missing`);
      assert.equal(id.primary, true, `${config.name}.id is not the primary key`);
      assert.equal(id.getSQLType(), 'uuid', `${config.name}.id is not a uuid`);
      assert.equal(id.hasDefault, true, `${config.name}.id has no default`);
    }
  });

  it('has created_at/updated_at everywhere except the append-only audit log', () => {
    for (const config of configs) {
      const names = config.columns.map((c) => c.name);
      assert.ok(names.includes('created_at'), `${config.name}.created_at missing`);
      if (config.name === 'audit_log') {
        assert.ok(!names.includes('updated_at'), 'audit_log must not have updated_at');
      } else {
        assert.ok(names.includes('updated_at'), `${config.name}.updated_at missing`);
      }
    }
  });

  it('declares the expected foreign keys and delete behaviour', () => {
    const fks = configs.flatMap((config) =>
      config.foreignKeys.map((fk) => {
        const ref = fk.reference();
        const column = ref.columns.map((c) => c.name).join(',');
        return `${config.name}.${column} -> ${getTableConfig(ref.foreignTable).name} (${fk.onDelete})`;
      }),
    );
    assert.deepEqual(fks.sort(), [
      'activities.section_id -> sections (cascade)',
      'audit_log.actor_user_id -> users (restrict)',
      'course_templates.program_id -> programs (restrict)',
      'courses.template_id -> course_templates (set null)',
      'courses.term_id -> terms (restrict)',
      'enrollments.course_id -> courses (cascade)',
      'enrollments.user_id -> users (restrict)',
      'sections.course_id -> courses (cascade)',
    ]);
  });

  it('declares the expected uniqueness constraints', () => {
    const uniques = configs.flatMap((config) => [
      ...config.uniqueConstraints.map(
        (u) => `${u.getName()}(${u.columns.map((c) => c.name).join(',')})`,
      ),
      ...config.indexes.filter((i) => i.config.unique).map((i) => `${i.config.name}(expression)`),
    ]);
    assert.deepEqual(uniques.sort(), [
      'course_templates_code_unique(code)',
      'courses_term_id_code_unique(term_id,code)',
      'enrollments_course_id_user_id_unique(course_id,user_id)',
      'programs_code_unique(code)',
      'terms_code_unique(code)',
      'users_email_lower_unique(expression)',
      'users_institutional_id_unique(institutional_id)',
    ]);
  });

  it('keeps administrator system-level and the other four roles course-level', () => {
    assert.deepEqual(schema.systemRoleEnum.enumValues, ['administrator', 'user']);
    assert.deepEqual(schema.courseRoleEnum.enumValues, [
      'design_team',
      'instructor',
      'non_editing_instructor',
      'student',
    ]);
    assert.equal(configOf('users').columns.find((c) => c.name === 'system_role')?.getSQLType(), 'system_role');
    assert.equal(configOf('enrollments').columns.find((c) => c.name === 'role')?.getSQLType(), 'course_role');
  });

  it('supports draft, published and archived course statuses', () => {
    assert.deepEqual(schema.courseStatusEnum.enumValues, ['draft', 'published', 'archived']);
  });

  it('gives sections and activities ordering and visibility fields', () => {
    for (const name of ['sections', 'activities']) {
      const columns = configOf(name).columns.map((c) => c.name);
      assert.ok(columns.includes('position'), `${name}.position missing`);
      assert.ok(columns.includes('is_visible'), `${name}.is_visible missing`);
    }
    const activityColumns = configOf('activities').columns;
    assert.equal(activityColumns.find((c) => c.name === 'type')?.getSQLType(), 'activity_type');
    assert.equal(activityColumns.find((c) => c.name === 'config')?.getSQLType(), 'jsonb');
  });
});
