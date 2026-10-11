import { Job, Worker } from 'bullmq';
import crypto from 'crypto';
import { pool } from '../db/pool';
import { getRedisOptions, routeToDeadLetter } from '../queue/digestQueue';

export interface DigestJobData {
  jobId: string;
  payload: any;
}

/**
 * Appends a state transition to the job_activity_logs table.
 */
export async function appendActivityLog(jobId: string, state: string, message: string): Promise<void> {
  const logId = crypto.randomUUID();
  await pool.query(
    'INSERT INTO job_activity_logs (id, job_id, state, message, created_at) VALUES ($1, $2, $3, $4, NOW())',
    [logId, jobId, state, message]
  );
  console.log(`[Worker] State transition logged for job ${jobId}: ${state} - ${message}`);
}

/**
 * Simulates processing delay for the nightly digest task.
 */
export async function simulateProcessingDelay(ms: number = 2000): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main worker processor logic for nightly digest jobs.
 */
export async function processDigestJob(job: Job<DigestJobData>): Promise<void> {
  const { jobId, payload } = job.data;
  console.log(`[Worker] Received job ${jobId} with payload:`, payload);

  try {
    // 1. Log started transition
    await appendActivityLog(jobId, 'started', 'Worker picked up job');

    // 2. Check for failure injection
    const simulateFailure =
      payload?.simulate_failure === true ||
      payload?.simulate_failure === 'true';

    if (simulateFailure) {
      throw new Error('Injected failure encountered during digest generation');
    }

    // 3. Simulate processing workload (2 seconds)
    await simulateProcessingDelay(2000);

    // 4. Log success transition
    await appendActivityLog(jobId, 'success', 'Digest generated successfully');
    console.log(`[Worker] Job ${jobId} successfully processed.`);
  } catch (error: any) {
    console.error(`[Worker] Job ${jobId} encountered an error: ${error.message}`);

    // 5. Handle failure transition
    await appendActivityLog(jobId, 'failed', error.message || 'Worker processing failed');

    // Brief pause to ensure strictly ascending created_at timestamp in database
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 6. Route to Dead Letter Queue (DLQ) and log dead_letter transition
    await routeToDeadLetter(jobId, payload, error.message || 'Worker processing failed');
    await appendActivityLog(jobId, 'dead_letter', 'Moved to DLQ due to fatal error');
    console.log(`[Worker] Job ${jobId} marked as dead_letter and routed to DLQ.`);
  }
}

/**
 * Starts the BullMQ worker instance.
 */
export function startWorker(): Worker<DigestJobData> {
  const redisOptions = getRedisOptions();
  const worker = new Worker<DigestJobData>(
    'nightly_digest',
    processDigestJob,
    {
      connection: redisOptions,
      concurrency: 5,
    }
  );

  worker.on('ready', () => {
    console.log('[Worker] BullMQ Worker is ready and connected to Redis.');
  });

  worker.on('error', (err) => {
    console.error('[Worker] BullMQ Worker error:', err);
  });

  return worker;
}
