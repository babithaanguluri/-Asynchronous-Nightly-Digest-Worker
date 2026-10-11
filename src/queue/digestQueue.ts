import { Queue } from 'bullmq';
import IORedis, { RedisOptions } from 'ioredis';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { pool } from '../db/pool';

dotenv.config();

export function getRedisOptions(): RedisOptions {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const parsed = new URL(redisUrl);
      return {
        host: parsed.hostname || 'localhost',
        port: parseInt(parsed.port || '6379', 10),
        username: parsed.username || undefined,
        password: parsed.password || undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      };
    } catch (e) {
      console.warn('[Queue] Could not parse REDIS_URL, falling back to host/port:', e);
    }
  }

  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

const redisOptions = getRedisOptions();

// Exported standalone Redis client for health checks
export const redisClient = new IORedis(redisOptions);

redisClient.on('error', (err) => {
  console.error('[Redis Client Error]', err);
});

// Primary Digest Queue
export const digestQueue = new Queue('nightly_digest', {
  connection: redisOptions,
});

// Dead Letter Queue for failed / fatal jobs
export const deadLetterQueue = new Queue('nightly_digest_dlq', {
  connection: redisOptions,
});

/**
 * Shared job enqueueing logic used by both manual POST /api/jobs/trigger and scheduled cron.
 * 1. Writes parent record to jobs table.
 * 2. Writes initial log to job_activity_logs with state 'pending'.
 * 3. Enqueues job to BullMQ.
 * 4. Returns jobId immediately without blocking.
 */
export async function enqueueJob(
  type: string = 'nightly_digest',
  payload: any = {}
): Promise<{ jobId: string; message: string }> {
  const jobId = crypto.randomUUID();
  const logId = crypto.randomUUID();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Insert parent record into jobs
    await client.query(
      'INSERT INTO jobs (id, name, payload, created_at) VALUES ($1, $2, $3, NOW())',
      [jobId, type, JSON.stringify(payload)]
    );

    // 2. Insert initial log record into job_activity_logs with state 'pending'
    await client.query(
      'INSERT INTO job_activity_logs (id, job_id, state, message, created_at) VALUES ($1, $2, $3, $4, NOW())',
      [logId, jobId, 'pending', 'Job created via API trigger']
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // 3. Enqueue to asynchronous worker
  await digestQueue.add('process_digest', {
    jobId,
    payload,
  });

  console.log(`[Queue] Enqueued job ${jobId} (type: ${type}) to BullMQ.`);

  return {
    jobId,
    message: 'Job accepted for processing',
  };
}

/**
 * Routes failed job to the Dead Letter Queue.
 */
export async function routeToDeadLetter(jobId: string, payload: any, errorReason: string): Promise<void> {
  console.log(`[DLQ] Routing job ${jobId} to Dead Letter Queue. Reason: ${errorReason}`);
  await deadLetterQueue.add('dead_letter_job', {
    jobId,
    payload,
    error: errorReason,
    routedAt: new Date().toISOString(),
  });
}
