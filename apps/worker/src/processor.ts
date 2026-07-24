import { incidentEvaluationJobSchema, type IncidentEvaluationJob } from '@outtrace/contracts';
import type pg from 'pg';

import { evaluateProcessInstance, type IncidentEvaluationResult } from './incident-engine.js';

export type { IncidentEvaluationResult } from './incident-engine.js';

export function validateIncidentEvaluationJob(data: unknown): IncidentEvaluationJob {
  return incidentEvaluationJobSchema.parse(data);
}

export async function processIncidentEvaluationJob(
  pool: pg.Pool,
  data: unknown,
  evaluate: typeof evaluateProcessInstance = evaluateProcessInstance,
): Promise<IncidentEvaluationResult> {
  const job = validateIncidentEvaluationJob(data);
  return evaluate(pool, job.workspaceId, job.processInstanceId);
}
