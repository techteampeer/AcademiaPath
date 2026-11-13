import { randomUUID } from 'node:crypto';
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
