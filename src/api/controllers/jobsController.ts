import { Request, Response, Router } from 'express';
import { enqueueJob } from '../../queue/digestQueue';
import { pool } from '../../db/pool';
import { JobLogsResponse, FormattedJobLog } from '../../models/types';

export const jobsRouter = Router();

/**
 * POST /api/jobs/trigger
 * Request Schema:
 * {
 *   "type": "nightly_digest",
 *   "simulate_failure": boolean (optional, default false)
 * }
 * Response Schema (202 Accepted):
 * {
 *   "job_id": "string (uuid)",
 *   "message": "string"
 * }
 */
jobsRouter.post('/trigger', async (req: Request, res: Response) => {
  try {
    const type = req.body?.type || 'nightly_digest';
    const simulateFailure =
      req.body?.simulate_failure === true ||
      req.body?.simulate_failure === 'true';

    const payload = {
      ...(typeof req.body === 'object' && req.body !== null ? req.body : {}),
      simulate_failure: simulateFailure,
    };

    // Asynchronously enqueues job and writes parent job + initial pending log
    const { jobId, message } = await enqueueJob(type, payload);

    // Return 202 Accepted immediately
    return res.status(202).json({
      job_id: jobId,
      message: message || 'Job accepted for processing',
    });
  } catch (error: any) {
    console.error('[API] Error in /api/jobs/trigger:', error);
    return res.status(500).json({
      error: 'Failed to enqueue job',
      details: error.message,
    });
  }
});

/**
 * GET /api/jobs/:job_id/logs
 * Response Schema (200 OK):
 * {
 *   "job_id": "string",
 *   "current_state": "string (derived from latest log)",
 *   "logs": [
 *     {
 *       "state": "string",
 *       "message": "string",
 *       "created_at": "string (ISO 8601)"
 *     }
 *   ]
 * }
 * Returns 404 if job_id does not exist.
 */
jobsRouter.get('/:job_id/logs', async (req: Request, res: Response) => {
  const { job_id } = req.params;

  if (!job_id) {
    return res.status(400).json({ error: 'job_id is required' });
  }

  // Basic UUID format check to avoid Postgres invalid uuid syntax errors
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job_id);
  if (!isUuid) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const client = await pool.connect();
  try {
    // 1. Verify existence of parent job
    const jobCheck = await client.query('SELECT id FROM jobs WHERE id = $1', [job_id]);
    if (jobCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // 2. Fetch all logs for this job ordered by created_at ascending
    const logsResult = await client.query(
      'SELECT state, message, created_at FROM job_activity_logs WHERE job_id = $1 ORDER BY created_at ASC',
      [job_id]
    );

    const logs: FormattedJobLog[] = logsResult.rows.map((row) => ({
      state: row.state,
      message: row.message || '',
      created_at: new Date(row.created_at).toISOString(),
    }));

    // Current state is derived from latest log
    const currentState = logs.length > 0 ? logs[logs.length - 1].state : 'pending';

    const responsePayload: JobLogsResponse = {
      job_id,
      current_state: currentState,
      logs,
    };

    return res.status(200).json(responsePayload);
  } catch (error: any) {
    console.error(`[API] Error retrieving logs for job ${job_id}:`, error);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});
