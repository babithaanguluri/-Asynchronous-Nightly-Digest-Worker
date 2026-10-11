import fs from 'fs';
import { runMigrations } from '../db/migrate';
import { startWorker } from './processor';

const HEARTBEAT_FILE = '/tmp/worker-heartbeat';

function updateHeartbeat(): void {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, Date.now().toString());
  } catch (err) {
    console.error('[Worker Heartbeat] Error writing heartbeat:', err);
  }
}

async function bootstrap(): Promise<void> {
  console.log('[Worker] Bootstrapping background worker process...');

  try {
    // 1. Ensure migrations are applied
    await runMigrations();

    // 2. Start the BullMQ worker
    const worker = startWorker();

    // 3. Setup heartbeat for Docker healthcheck
    updateHeartbeat();
    const heartbeatInterval = setInterval(updateHeartbeat, 3000);

    console.log('[Worker] Background worker process started successfully.');

    // 4. Handle graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`[Worker] Received ${signal}. Shutting down worker...`);
      clearInterval(heartbeatInterval);
      await worker.close();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    console.error('[Worker] Fatal error during worker startup:', error);
    process.exit(1);
  }
}

bootstrap();
