import { INCIDENT_EVALUATION_QUEUE, type IncidentEvaluationJob } from '@outtrace/contracts';
import { Worker, type Job } from 'bullmq';
import type pg from 'pg';

import type { WorkerConfig } from './config.js';
import { processIncidentEvaluationJob, type IncidentEvaluationResult } from './processor.js';
import type { RedisConnection } from './redis.js';

export type IncidentWorker = Worker<
  IncidentEvaluationJob,
  IncidentEvaluationResult,
  typeof INCIDENT_EVALUATION_QUEUE
>;

export function createIncidentEvaluationWorker(
  connection: RedisConnection,
  config: WorkerConfig,
  pool: pg.Pool,
): IncidentWorker {
  return new Worker<
    IncidentEvaluationJob,
    IncidentEvaluationResult,
    typeof INCIDENT_EVALUATION_QUEUE
  >(
    INCIDENT_EVALUATION_QUEUE,
    async (job: Job<IncidentEvaluationJob>) => processIncidentEvaluationJob(pool, job.data),
    {
      connection,
      concurrency: config.concurrency,
      lockDuration: config.lockDurationMs,
    },
  );
}
