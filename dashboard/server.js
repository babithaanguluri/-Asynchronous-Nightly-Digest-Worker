const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/nightly_digest',
  max: 10,
  idleTimeoutMillis: 10000,
});

// System telemetry & stats
app.get('/api/stats', async (_req, res) => {
  try {
    const totalJobsRes = await pool.query('SELECT count(*) FROM jobs');
    const stateCountsRes = await pool.query(`
      WITH latest_logs AS (
        SELECT DISTINCT ON (job_id) job_id, state
        FROM job_activity_logs
        ORDER BY job_id, created_at DESC
      )
      SELECT state, count(*) FROM latest_logs GROUP BY state
    `);

    const stateMap = {};
    stateCountsRes.rows.forEach(r => {
      stateMap[r.state] = parseInt(r.count, 10);
    });

    const recentJobsRes = await pool.query(`
      SELECT j.id, j.name, j.payload, j.created_at,
        (SELECT state FROM job_activity_logs WHERE job_id = j.id ORDER BY created_at DESC LIMIT 1) as current_state
      FROM jobs j
      ORDER BY j.created_at DESC
      LIMIT 10
    `);

    res.json({
      totalJobs: parseInt(totalJobsRes.rows[0].count, 10),
      successCount: stateMap['success'] || 0,
      deadLetterCount: stateMap['dead_letter'] || 0,
      startedCount: stateMap['started'] || 0,
      pendingCount: stateMap['pending'] || 0,
      failedCount: stateMap['failed'] || 0,
      recentJobs: recentJobsRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run verification suite and return output
app.post('/api/run-tests', (_req, res) => {
  const rootDir = path.resolve(__dirname, '..');
  exec('npx ts-node src/tests/verify.ts', { cwd: rootDir, timeout: 45000 }, (error, stdout, stderr) => {
    const output = stdout + (stderr ? '\n' + stderr : '');
    const passMatches = output.match(/\[PASS\]/g) || [];
    const failMatches = output.match(/\[FAIL\]/g) || [];
    const isSuccess = !error && failMatches.length === 0;

    res.json({
      success: isSuccess,
      exitCode: error ? error.code : 0,
      passedCount: passMatches.length,
      failedCount: failMatches.length,
      output: output,
    });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Dashboard] Interactive UI server running at http://localhost:${PORT}`);
});
