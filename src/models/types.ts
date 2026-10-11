export type JobState = 'pending' | 'started' | 'success' | 'failed' | 'dead_letter';

export interface JobRecord {
  id: string;
  name: string;
  payload: any;
  created_at: Date;
}

export interface JobActivityLogRecord {
  id: string;
  job_id: string;
  state: JobState;
  message: string | null;
  created_at: Date;
}

export interface TriggerJobRequest {
  type?: string;
  simulate_failure?: boolean | string;
  [key: string]: any;
}

export interface TriggerJobResponse {
  job_id: string;
  message: string;
}

export interface FormattedJobLog {
  state: string;
  message: string;
  created_at: string;
}

export interface JobLogsResponse {
  job_id: string;
  current_state: string;
  logs: FormattedJobLog[];
}
