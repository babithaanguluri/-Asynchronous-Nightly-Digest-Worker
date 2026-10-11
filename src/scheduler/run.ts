import { startScheduler } from './index';

console.log('[Scheduler Process] Launching standalone cron scheduler...');
startScheduler();

// Keep process running
process.stdin.resume();
