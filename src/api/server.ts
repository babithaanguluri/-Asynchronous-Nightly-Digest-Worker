import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from '../db/pool';
import { runMigrations } from '../db/migrate';
import { jobsRouter } from './controllers/jobsController';
import { startScheduler } from '../scheduler';
import { redisClient } from '../queue/digestQueue';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

// Healthcheck endpoints for docker-compose and monitoring
app.get('/health', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    const redisPong = await redisClient.ping();
    if (redisPong !== 'PONG') {
      return res.status(503).json({ status: 'degraded', redis: redisPong });
    }
    return res.status(200).json({ status: 'healthy' });
  } catch (err: any) {
    return res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

app.get('/api/health', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    return res.status(200).json({ status: 'healthy' });
  } catch (err: any) {
    return res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

// Mount Jobs API
app.use('/api/jobs', jobsRouter);

const PORT = parseInt(process.env.API_PORT || process.env.PORT || '3000', 10);

async function startServer(): Promise<void> {
  try {
    console.log('[API] Running automated database migrations...');
    await runMigrations();

    console.log('[API] Starting native cron scheduler...');
    startScheduler();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[API Server] Successfully running on http://0.0.0.0:${PORT}`);
    });
  } catch (error) {
    console.error('[API Server] Startup failure:', error);
    process.exit(1);
  }
}

// Start API server
startServer();

export default app;
