const API_BASE = 'http://localhost:3000';
const DASHBOARD_BASE = '';

let activePollTimer = null;
let currentTrackingJobId = null;

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadStats();
  loadRecentJobs();
  checkHealth();
  setInterval(loadStats, 4000);
});

function setupEventListeners() {
  document.getElementById('btn-trigger-success').addEventListener('click', () => triggerJob(false));
  document.getElementById('btn-trigger-failure').addEventListener('click', () => triggerJob(true));
  document.getElementById('btn-trigger-burst').addEventListener('click', triggerBurst);
  document.getElementById('btn-run-tests').addEventListener('click', runAutomatedTests);
  document.getElementById('btn-refresh-history').addEventListener('click', loadRecentJobs);
}

// Health checks
async function checkHealth() {
  try {
    const res = await fetch(`${API_BASE}/health`);
    if (res.ok) {
      document.getElementById('pill-api').classList.add('healthy');
      document.getElementById('pill-db').classList.add('healthy');
      document.getElementById('pill-redis').classList.add('healthy');
      document.getElementById('pill-worker').classList.add('healthy');
    }
  } catch (err) {
    console.warn('Health check issue:', err);
  }
}

// Load stats
async function loadStats() {
  try {
    const res = await fetch(`${DASHBOARD_BASE}/api/stats`);
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('stat-total').textContent = data.totalJobs ?? 0;
    document.getElementById('stat-success').textContent = data.successCount ?? 0;
    document.getElementById('stat-dlq').textContent = data.deadLetterCount ?? 0;
  } catch (err) {
    console.warn('Stats fetch error:', err);
  }
}

// Load recent jobs table
async function loadRecentJobs() {
  try {
    const res = await fetch(`${DASHBOARD_BASE}/api/stats`);
    if (!res.ok) return;
    const data = await res.json();
    const tbody = document.getElementById('jobs-table-body');
    if (!data.recentJobs || data.recentJobs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center">No jobs found</td></tr>';
      return;
    }

    tbody.innerHTML = data.recentJobs.map((j) => {
      const state = j.current_state || 'pending';
      const createdStr = new Date(j.created_at).toLocaleTimeString();
      return `
        <tr>
          <td><span class="mono-id" style="font-size:0.75rem;">${j.id.slice(0, 8)}...</span></td>
          <td>${j.name}</td>
          <td><span class="state-badge ${state}">${state}</span></td>
          <td>${createdStr}</td>
          <td>
            <button class="btn-sm" onclick="trackExistingJob('${j.id}')">Inspect</button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.warn('Recent jobs error:', err);
  }
}

// Trigger Job (Success or Injected Failure)
async function triggerJob(simulateFailure) {
  if (activePollTimer) clearInterval(activePollTimer);

  const triggerBtn = simulateFailure 
    ? document.getElementById('btn-trigger-failure') 
    : document.getElementById('btn-trigger-success');

  const origText = triggerBtn.innerHTML;
  triggerBtn.style.opacity = '0.7';

  try {
    const t0 = performance.now();
    const res = await fetch(`${API_BASE}/api/jobs/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'nightly_digest',
        simulate_failure: simulateFailure,
        client_timestamp: new Date().toISOString()
      }),
    });

    const elapsed = Math.round(performance.now() - t0);
    document.getElementById('stat-sla').textContent = `${elapsed}ms`;

    if (!res.ok) {
      alert(`Trigger failed with status: ${res.status}`);
      return;
    }

    const data = await res.json();
    const jobId = data.job_id;
    trackJob(jobId);
  } catch (err) {
    alert(`Trigger error: ${err.message}`);
  } finally {
    triggerBtn.style.opacity = '1';
  }
}

// Track an existing job from the table
window.trackExistingJob = function(jobId) {
  if (activePollTimer) clearInterval(activePollTimer);
  trackJob(jobId);
};

// Track job state progression
function trackJob(jobId) {
  currentTrackingJobId = jobId;
  document.getElementById('active-job-id').textContent = jobId;
  resetStateMachine();

  let attempts = 0;
  const poll = async () => {
    attempts++;
    try {
      const res = await fetch(`${API_BASE}/api/jobs/${jobId}/logs`);
      if (!res.ok) return;
      const data = await res.json();
      updateTrackerUI(data);

      if (data.current_state === 'success' || data.current_state === 'dead_letter' || attempts > 25) {
        clearInterval(activePollTimer);
        loadStats();
        loadRecentJobs();
      }
    } catch (err) {
      console.warn('Poll error:', err);
    }
  };

  poll();
  activePollTimer = setInterval(poll, 700);
}

// Update State Machine & Logs UI
function updateTrackerUI(jobData) {
  const stateTag = document.getElementById('active-state-tag');
  stateTag.textContent = jobData.current_state.toUpperCase();
  stateTag.className = `job-state-tag ${jobData.current_state}`;

  resetStateMachine();

  const logs = jobData.logs || [];
  const statesEncountered = logs.map(l => l.state);

  if (statesEncountered.includes('pending')) {
    document.getElementById('sm-pending').classList.add('active');
  }
  if (statesEncountered.includes('started')) {
    document.getElementById('line-1').classList.add('active');
    document.getElementById('sm-started').classList.add('active');
  }
  if (statesEncountered.includes('success')) {
    document.getElementById('line-2').classList.add('active');
    document.getElementById('sm-success').classList.add('active');
  }
  if (statesEncountered.includes('failed')) {
    document.getElementById('line-2').classList.add('active');
    document.getElementById('sm-failed').classList.add('active');
  }
  if (statesEncountered.includes('dead_letter')) {
    document.getElementById('line-3').classList.add('active');
    document.getElementById('sm-dead_letter').classList.add('active');
  }

  // Render logs timeline
  const timelineEl = document.getElementById('active-logs-timeline');
  if (logs.length === 0) {
    timelineEl.innerHTML = '<div class="log-placeholder">Waiting for worker processing...</div>';
    return;
  }

  timelineEl.innerHTML = logs.map((l) => {
    const timeStr = new Date(l.created_at).toLocaleTimeString();
    return `
      <div class="log-entry ${l.state}">
        <span class="log-time">${timeStr}</span>
        <span class="log-badge ${l.state}">${l.state}</span>
        <span class="log-msg">${l.message}</span>
      </div>
    `;
  }).join('');
}

function resetStateMachine() {
  ['sm-pending', 'sm-started', 'sm-success', 'sm-failed', 'sm-dead_letter'].forEach(id => {
    document.getElementById(id).classList.remove('active');
  });
  ['line-1', 'line-2', 'line-3'].forEach(id => {
    document.getElementById(id).classList.remove('active');
  });
}

// Trigger Burst Test
async function triggerBurst() {
  const btn = document.getElementById('btn-trigger-burst');
  btn.style.opacity = '0.7';

  const t0 = performance.now();
  const promises = Array.from({ length: 10 }, (_, i) => 
    fetch(`${API_BASE}/api/jobs/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'nightly_digest', burstIndex: i })
    })
  );

  const responses = await Promise.all(promises);
  const totalDuration = Math.round(performance.now() - t0);
  btn.style.opacity = '1';

  const all202 = responses.every(r => r.status === 202);
  const firstData = await responses[0].json();
  trackJob(firstData.job_id);

  const terminal = document.getElementById('terminal-content');
  terminal.textContent = `[BURST STRESS TEST COMPLETED]\n` +
    `Dispatched: 10 concurrent POST requests\n` +
    `All returned HTTP 202 Accepted: ${all202}\n` +
    `Total roundtrip time: ${totalDuration}ms (Threshold SLA: < 1500ms)\n` +
    `First Job UUID: ${firstData.job_id}\n` +
    `BullMQ Worker concurrency: 5 parallel workers handling ingest.\n`;
  
  loadStats();
  loadRecentJobs();
}

// Run Automated Test Suite
async function runAutomatedTests() {
  const badge = document.getElementById('verify-status-badge');
  const terminal = document.getElementById('terminal-content');
  const btn = document.getElementById('btn-run-tests');

  badge.textContent = 'RUNNING...';
  badge.className = 'badge';
  badge.style.background = 'rgba(245, 158, 11, 0.2)';
  badge.style.color = '#fbbf24';
  terminal.textContent = 'Executing test suite: npx ts-node src/tests/verify.ts ...\nPlease wait while database constraints, state transitions, and SLA checks run...';
  btn.style.opacity = '0.7';

  try {
    const res = await fetch(`${DASHBOARD_BASE}/api/run-tests`, { method: 'POST' });
    const result = await res.json();

    terminal.textContent = result.output;
    terminal.scrollTop = terminal.scrollHeight;

    if (result.success) {
      badge.textContent = `${result.passedCount}/${result.passedCount} ALL PASSED`;
      badge.className = 'badge badge-verify';
      badge.style.background = '';
      badge.style.color = '';
    } else {
      badge.textContent = `FAILED (${result.failedCount})`;
      badge.style.background = 'rgba(239, 68, 68, 0.2)';
      badge.style.color = '#ef4444';
    }
  } catch (err) {
    terminal.textContent += `\nExecution error: ${err.message}`;
    badge.textContent = 'ERROR';
  } finally {
    btn.style.opacity = '1';
    loadStats();
    loadRecentJobs();
  }
}
