-- Initialize database schema for Asynchronous Nightly Digest Worker
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Jobs table
CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    payload JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Job Activity Logs table
CREATE TABLE IF NOT EXISTS job_activity_logs (
    id UUID PRIMARY KEY,
    job_id UUID NOT NULL,
    state VARCHAR(50) NOT NULL,
    message TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT fk_jobs FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

-- Performance indexes for lookup and chronological ordering
CREATE INDEX IF NOT EXISTS idx_job_activity_logs_job_id ON job_activity_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_job_activity_logs_created_at ON job_activity_logs(created_at);
