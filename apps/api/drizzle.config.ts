import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// Scripts run from apps/api; load the repository-root .env when present.
const rootEnv = '../../.env';
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  // Only needed by commands that connect (migrate). `generate` and `check` work offline.
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
});
