import { z } from 'zod';

export const incidentFeedbackVerdicts = ['genuine', 'false_positive'] as const;
export const incidentFalsePositiveReasons = [
  'timeout_too_short',
  'stage_not_required',
  'expected_sequence_variation',
  'test_or_duplicate_traffic',
  'other',
] as const;

export const incidentFeedbackSchema = z.object({
  incidentId: z.string().min(1),
  verdict: z.enum(incidentFeedbackVerdicts),
  reason: z.enum(incidentFalsePositiveReasons).nullable(),
  note: z.string().nullable(),
  reviewedBy: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const incidentFeedbackUpdateSchema = z
  .object({
    verdict: z.enum(incidentFeedbackVerdicts),
    reason: z.enum(incidentFalsePositiveReasons).nullable().optional(),
    note: z.string().trim().max(2_000).nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.verdict === 'false_positive' && !value.reason) {
      context.addIssue({
        code: 'custom',
        message: 'A reason is required for false-positive feedback.',
        path: ['reason'],
      });
    }
    if (value.verdict === 'genuine' && value.reason) {
      context.addIssue({
        code: 'custom',
        message: 'False-positive reasons apply only to false-positive feedback.',
        path: ['reason'],
      });
    }
  });

export const pilotProcessStatusSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  name: z.string().min(1),
  clientId: z.string().min(1),
  clientName: z.string().min(1),
  connectionStatus: z.enum(['awaiting_first_event', 'connected']),
  eventCount: z.number().int().nonnegative(),
  connectedAt: z.iso.datetime().nullable(),
  lastEventAt: z.iso.datetime().nullable(),
});

export const pilotSummarySchema = z.object({
  windowDays: z.literal(28),
  windowStartedAt: z.iso.datetime(),
  generatedAt: z.iso.datetime(),
  activation: z.object({
    totalProcesses: z.number().int().nonnegative(),
    connectedProcesses: z.number().int().nonnegative(),
    awaitingFirstEvent: z.number().int().nonnegative(),
    connectionRate: z.number().min(0).max(1),
    medianSecondsToFirstEvent: z.number().nonnegative().nullable(),
  }),
  quality: z.object({
    incidentsDetected: z.number().int().nonnegative(),
    reviewedIncidents: z.number().int().nonnegative(),
    genuineIncidents: z.number().int().nonnegative(),
    falsePositiveIncidents: z.number().int().nonnegative(),
    unreviewedIncidents: z.number().int().nonnegative(),
    falsePositiveRate: z.number().min(0).max(1).nullable(),
  }),
  processes: z.array(pilotProcessStatusSchema),
});

export type IncidentFeedback = z.infer<typeof incidentFeedbackSchema>;
export type IncidentFeedbackUpdate = z.infer<typeof incidentFeedbackUpdateSchema>;
export type IncidentFalsePositiveReason = (typeof incidentFalsePositiveReasons)[number];
export type PilotProcessStatus = z.infer<typeof pilotProcessStatusSchema>;
export type PilotSummary = z.infer<typeof pilotSummarySchema>;
