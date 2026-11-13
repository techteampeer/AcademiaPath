import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createDatabase } from '../../src/db/client.js';

/**
 * Local PostgreSQL server URL whose role may CREATE DATABASE. Database tests are skipped
 * when unset. Each test file gets its own temporary database; existing databases are never touched.
 */
export const testServerUrl = process.env.TEST_DATABASE_URL;

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

async function runOnServer(statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: testServerUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

/**
 * Creates a uniquely named database with all migrations applied (or those of `options.migrationsFolder`,
 * e.g. a copy holding only the earlier ones, to test a migration against existing rows). Call `drop()` when done.
 */
export async function createTestDatabase(options: { migrationsFolder?: string } = {}) {
  if (!testServerUrl) throw new Error('TEST_DATABASE_URL is not set');
  const name = `academiapath_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await runOnServer(`CREATE DATABASE "${name}"`);

  const url = new URL(testServerUrl);
  url.pathname = `/${name}`;
  const database = createDatabase(url.toString());
  const drop = async () => {
    // Teardown only: a pooled connection still closing when the database is force-dropped reports
    // "terminating connection due to administrator command"; without a listener that late error would
    // crash the test file after all of its tests have finished.
    database.pool.on('error', () => {});
    await database.pool.end();
    await runOnServer(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  };

  try {
    await migrate(database.db, { migrationsFolder: options.migrationsFolder ?? migrationsFolder });
  } catch (error) {
    await drop();
    throw error;
  }
  return { ...database, drop, url: url.toString() };
}

/**
 * A temporary copy of the migrations that come strictly before `tag` in the journal (for example everything before
 * `0035_hybrid_teaching_sessions`), to build a database as it was before a migration and then apply the rest.
 * Call `cleanup()` when done.
 */
export async function migrationsBefore(tag: string): Promise<{ folder: string; cleanup: () => Promise<void> }> {
  const journal = JSON.parse(await readFile(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
  const target = journal.entries.find((entry) => entry.tag === tag);
  if (!target) throw new Error(`Unknown migration ${tag}`);
  const kept = journal.entries.filter((entry) => entry.idx < target.idx);
  const folder = await mkdtemp(path.join(tmpdir(), 'academiapath-migrations-'));
  await cp(path.join(migrationsFolder, 'meta'), path.join(folder, 'meta'), { recursive: true });
  await writeFile(path.join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: kept }));
  const files = new Set(kept.map((entry) => `${entry.tag}.sql`));
  for (const file of await readdir(migrationsFolder)) if (files.has(file)) await cp(path.join(migrationsFolder, file), path.join(folder, file));
  return { folder, cleanup: () => rm(folder, { recursive: true, force: true }) };
}
