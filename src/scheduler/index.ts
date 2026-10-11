import cron from 'node-cron';
import { enqueueJob } from '../queue/digestQueue';

export const DEFAULT_CRON_SCHEDULE = '0 0 * * *';
export const CRON_SCHEDULE = process.env.CRON_SCHEDULE || DEFAULT_CRON_SCHEDULE;

/**
 * Initializes and starts the scheduled cron job for triggering the nightly digest.
 * Configured by default to run at midnight (0 0 * * *) or via CRON_SCHEDULE environment variable.
 * Uses the exact same enqueueJob logic as the manual API trigger endpoint.
 */
export function startScheduler(): cron.ScheduledTask {
  console.log(`[Scheduler] Initializing cron scheduler with expression: ${CRON_SCHEDULE}`);

  const task = cron.schedule(CRON_SCHEDULE, async () => {
    console.log('[Scheduler] Cron trigger activated. Enqueueing nightly_digest job...');
    try {
      const result = await enqueueJob('nightly_digest', {
        simulate_failure: false,
        source: 'cron_scheduler',
      });
      console.log(`[Scheduler] Successfully enqueued scheduled nightly_digest job: ${result.jobId}`);
    } catch (error) {
      console.error('[Scheduler] Failed to enqueue scheduled nightly_digest job:', error);
    }
  });

  return task;
}
