import { incidentEvaluationJobSchema, type IncidentEvaluationJob } from '@outtrace/contracts';

export interface IncidentEvaluationResult {
  evaluated: false;
  reason: 'phase_2_not_implemented';
}

export function validateIncidentEvaluationJob(data: unknown): IncidentEvaluationJob {
  return incidentEvaluationJobSchema.parse(data);
}

export async function processIncidentEvaluationJob(
  data: unknown,
): Promise<IncidentEvaluationResult> {
  validateIncidentEvaluationJob(data);

  return {
    evaluated: false,
    reason: 'phase_2_not_implemented',
  };
}
