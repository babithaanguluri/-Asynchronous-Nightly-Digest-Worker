import { pool } from './pool';
import fs from 'fs';
import path from 'path';

export async function runMigrations(maxRetries: number = 30, retryIntervalMs: number = 2000): Promise<void> {
  console.log('[Migration] Starting automated database migration...');

  // SQL DDL
  const ddl = `
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    CREATE TABLE IF NOT EXISTS jobs (
        id UUID PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        payload JSONB,
        created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS job_activity_logs (
        id UUID PRIMARY KEY,
        job_id UUID NOT NULL,
        state VARCHAR(50) NOT NULL,
        message TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT fk_jobs FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_job_activity_logs_job_id ON job_activity_logs(job_id);
    CREATE INDEX IF NOT EXISTS idx_job_activity_logs_created_at ON job_activity_logs(created_at);
  `;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query(ddl);
      await client.query('COMMIT');
      console.log('[Migration] Database migrations applied successfully.');
      return;
    } catch (error: any) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {}
      }
      console.warn(`[Migration] Attempt ${attempt}/${maxRetries} failed: ${error.message}. Retrying in ${retryIntervalMs}ms...`);
      if (attempt === maxRetries) {
        console.error('[Migration] All migration attempts exhausted.');
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
    } finally {
      if (client) {
        client.release();
      }
    }
  }
}

// Allow direct execution via CLI (e.g. npm run migrate)
if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log('[Migration] Migration CLI execution finished.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Migration] Migration CLI execution failed:', err);
      process.exit(1);
    });
}
