import { pool } from '../db/pool';
import fs from 'fs';
import path from 'path';

const API_BASE = 'http://localhost:3000';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runVerification() {
  console.log('====================================================');
  console.log('Starting Automated Verification for Nightly Digest System');
  console.log('====================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string, details?: any) {
    totalTests++;
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passedTests++;
    } else {
      console.error(`[FAIL] ${testName}`, details || '');
      throw new Error(`Assertion failed: ${testName}`);
    }
  }

  // 1. Verify submission.json
  console.log('--- Test 1: submission.json format & content ---');
  const submissionPath = path.resolve(__dirname, '../../submission.json');
  assert(fs.existsSync(submissionPath), 'submission.json exists');
  const submissionData = JSON.parse(fs.readFileSync(submissionPath, 'utf8'));
  assert(typeof submissionData.evaluationConfig?.apiPort === 'number', 'apiPort is a number', submissionData);
  assert(submissionData.evaluationConfig?.queueImplementation === 'redis', 'queueImplementation is redis', submissionData);

  // 2. Verify .env.example
  console.log('\n--- Test 2: .env.example format & content ---');
  const envExamplePath = path.resolve(__dirname, '../../.env.example');
  assert(fs.existsSync(envExamplePath), '.env.example exists');
  const envContent = fs.readFileSync(envExamplePath, 'utf8');
  assert(envContent.includes('DATABASE_URL='), '.env.example includes DATABASE_URL');
  assert(envContent.includes('REDIS_URL='), '.env.example includes REDIS_URL');
  assert(envContent.includes('CRON_SCHEDULE='), '.env.example includes CRON_SCHEDULE');

  // 3. Verify Database Schema & Foreign Key Constraints
  console.log('\n--- Test 3: Database Schema & FK Constraint ---');
  const client = await pool.connect();
  try {
    // Check tables exist
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name IN ('jobs', 'job_activity_logs');
    `);
    const tableNames = tablesRes.rows.map((r) => r.table_name);
    assert(tableNames.includes('jobs'), 'Table "jobs" exists');
    assert(tableNames.includes('job_activity_logs'), 'Table "job_activity_logs" exists');

    // Check columns in jobs
    const jobsCols = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'jobs';
    `);
    const jobsColNames = jobsCols.rows.map((r) => r.column_name);
    assert(jobsColNames.includes('id'), 'jobs table has id column');
    assert(jobsColNames.includes('name'), 'jobs table has name column');
    assert(jobsColNames.includes('payload'), 'jobs table has payload column');
    assert(jobsColNames.includes('created_at'), 'jobs table has created_at column');

    // Check columns in job_activity_logs
    const logsCols = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'job_activity_logs';
    `);
    const logsColNames = logsCols.rows.map((r) => r.column_name);
    assert(logsColNames.includes('id'), 'job_activity_logs has id column');
    assert(logsColNames.includes('job_id'), 'job_activity_logs has job_id column');
    assert(logsColNames.includes('state'), 'job_activity_logs has state column');
    assert(logsColNames.includes('message'), 'job_activity_logs has message column');
    assert(logsColNames.includes('created_at'), 'job_activity_logs has created_at column');

    // Check foreign key constraint
    const fkRes = await client.query(`
      SELECT
        tc.table_name, kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = 'job_activity_logs'
        AND kcu.column_name = 'job_id';
    `);
    assert(fkRes.rows.length > 0, 'Foreign key constraint exists on job_activity_logs.job_id');
    assert(fkRes.rows[0].foreign_table_name === 'jobs', 'Foreign key references "jobs" table');
  } finally {
    client.release();
  }

  // 4. Test Success Flow (simulate_failure: false)
  console.log('\n--- Test 4: Success Flow (simulate_failure: false) ---');
  const t0 = Date.now();
  const triggerRes = await fetch(`${API_BASE}/api/jobs/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'nightly_digest', simulate_failure: false }),
  });
  const tElapsed = Date.now() - t0;
  assert(triggerRes.status === 202, 'POST /api/jobs/trigger returns 202 Accepted');
  assert(tElapsed < 500, `POST /api/jobs/trigger responded in ${tElapsed}ms (< 500ms)`);

  const triggerBody = (await triggerRes.json()) as any;
  assert(typeof triggerBody.job_id === 'string', 'Response contains job_id', triggerBody);
  const successJobId = triggerBody.job_id;
  console.log(`Triggered job ID: ${successJobId}. Polling logs...`);

  let successLogs: any[] = [];
  let pollAttempts = 0;
  while (pollAttempts < 15) {
    await sleep(1000);
    pollAttempts++;
    const logRes = await fetch(`${API_BASE}/api/jobs/${successJobId}/logs`);
    assert(logRes.status === 200, `GET /api/jobs/${successJobId}/logs returns 200`);
    const logBody = (await logRes.json()) as any;
    successLogs = logBody.logs;
    const states = successLogs.map((l) => l.state);
    console.log(`Poll ${pollAttempts}s: current_state=${logBody.current_state}, states=[${states.join(' -> ')}]`);
    if (logBody.current_state === 'success') {
      break;
    }
  }

  const finalSuccessStates = successLogs.map((l) => l.state);
  assert(
    JSON.stringify(finalSuccessStates) === JSON.stringify(['pending', 'started', 'success']),
    'Logs sequence is exactly pending -> started -> success',
    finalSuccessStates
  );

  // 5. Test Failure & DLQ Flow (simulate_failure: true)
  console.log('\n--- Test 5: Failure & DLQ Flow (simulate_failure: true) ---');
  const failTriggerRes = await fetch(`${API_BASE}/api/jobs/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'nightly_digest', simulate_failure: true }),
  });
  assert(failTriggerRes.status === 202, 'POST /api/jobs/trigger with simulate_failure=true returns 202');
  const failTriggerBody = (await failTriggerRes.json()) as any;
  const failJobId = failTriggerBody.job_id;
  console.log(`Triggered failed job ID: ${failJobId}. Polling logs...`);

  let failLogs: any[] = [];
  pollAttempts = 0;
  while (pollAttempts < 15) {
    await sleep(1000);
    pollAttempts++;
    const logRes = await fetch(`${API_BASE}/api/jobs/${failJobId}/logs`);
    assert(logRes.status === 200, `GET /api/jobs/${failJobId}/logs returns 200`);
    const logBody = (await logRes.json()) as any;
    failLogs = logBody.logs;
    const states = failLogs.map((l) => l.state);
    console.log(`Poll ${pollAttempts}s: current_state=${logBody.current_state}, states=[${states.join(' -> ')}]`);
    if (logBody.current_state === 'dead_letter') {
      break;
    }
  }

  const finalFailStates = failLogs.map((l) => l.state);
  assert(
    JSON.stringify(finalFailStates) === JSON.stringify(['pending', 'started', 'failed', 'dead_letter']),
    'Logs sequence is exactly pending -> started -> failed -> dead_letter',
    finalFailStates
  );

  // 6. Test 404 for non-existent job
  console.log('\n--- Test 6: 404 Handling for non-existent job ---');
  const notFoundRes = await fetch(`${API_BASE}/api/jobs/00000000-0000-0000-0000-000000000000/logs`);
  assert(notFoundRes.status === 404, 'GET /api/jobs/{invalid_id}/logs returns 404');

  // 7. Test Burst of 10 Requests (< 1.5s total)
  console.log('\n--- Test 7: Burst of 10 concurrent trigger requests ---');
  const burstStart = Date.now();
  const promises = Array.from({ length: 10 }, (_, i) =>
    fetch(`${API_BASE}/api/jobs/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'nightly_digest', simulate_failure: false, burstIndex: i }),
    })
  );
  const responses = await Promise.all(promises);
  const burstDuration = Date.now() - burstStart;
  console.log(`Burst of 10 requests completed in ${burstDuration}ms`);
  assert(burstDuration < 1500, `10 requests returned in under 1.5s (took ${burstDuration}ms)`);
  responses.forEach((res, i) => {
    assert(res.status === 202, `Burst request #${i + 1} returned status 202`);
  });

  console.log('\n====================================================');
  console.log(`ALL ${passedTests}/${totalTests} TESTS PASSED SUCCESSFULLY!`);
  console.log('====================================================');
  await pool.end();
}

runVerification().catch((err) => {
  console.error('\nVerification failed:', err);
  process.exit(1);
});
