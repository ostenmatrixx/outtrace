import { z } from 'zod';

export const INCIDENT_EVALUATION_QUEUE = 'incident-evaluation';

export const incidentEvaluationJobSchema = z.object({
  workspaceId: z.string().min(1),
  processInstanceId: z.string().min(1),
  eventId: z.string().min(1),
});

export type IncidentEvaluationJob = z.infer<typeof incidentEvaluationJobSchema>;
