import { z } from 'zod';

import { incidentFeedbackSchema } from './pilot.js';

export const incidentTypes = [
  'reported_failure',
  'missing_stage',
  'sla_violation',
  'unexpected_sequence',
] as const;
export const incidentSeverities = ['critical', 'high', 'medium', 'low'] as const;
export const incidentStatuses = ['open', 'acknowledged', 'resolved'] as const;

export const incidentTypeSchema = z.enum(incidentTypes);
export const incidentSeveritySchema = z.enum(incidentSeverities);
export const incidentStatusSchema = z.enum(incidentStatuses);

export const incidentSummarySchema = z.object({
  id: z.string().min(1),
  incidentType: incidentTypeSchema,
  severity: incidentSeveritySchema,
  status: incidentStatusSchema,
  affectedStage: z.string().nullable(),
  technicalMessage: z.string(),
  businessMessage: z.string(),
  assignedTo: z.string().nullable(),
  source: z.string().nullable(),
  executionUrl: z.string().url().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  acknowledgedAt: z.iso.datetime().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  client: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  process: z.object({
    id: z.string().min(1),
    key: z.string().min(1),
    name: z.string().min(1),
  }),
  instance: z.object({
    id: z.string().min(1),
    key: z.string().min(1),
    status: z.string().min(1),
  }),
});

export const incidentEventSchema = z.object({
  id: z.string().min(1),
  eventId: z.string().min(1),
  stage: z.string().min(1),
  status: z.string().min(1),
  source: z.string().min(1),
  executionUrl: z.string().url().nullable(),
  occurredAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
});

export const incidentNoteSchema = z.object({
  id: z.string().min(1),
  author: z.string().min(1),
  body: z.string().min(1),
  createdAt: z.iso.datetime(),
});

export const incidentDetailSchema = incidentSummarySchema.extend({
  timeline: z.array(incidentEventSchema),
  notes: z.array(incidentNoteSchema),
  feedback: incidentFeedbackSchema.nullable(),
});

export const incidentListResponseSchema = z.object({
  incidents: z.array(incidentSummarySchema),
  total: z.number().int().nonnegative(),
});

export const incidentStatusUpdateSchema = z
  .object({
    status: z.enum(['acknowledged', 'resolved']).optional(),
    assignedTo: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .refine((value) => value.status !== undefined || value.assignedTo !== undefined, {
    message: 'At least one incident change is required.',
  });

export const incidentNoteCreateSchema = z.object({
  author: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4_000),
});

export type IncidentType = z.infer<typeof incidentTypeSchema>;
export type IncidentSeverity = z.infer<typeof incidentSeveritySchema>;
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;
export type IncidentSummary = z.infer<typeof incidentSummarySchema>;
export type IncidentDetail = z.infer<typeof incidentDetailSchema>;
export type IncidentListResponse = z.infer<typeof incidentListResponseSchema>;
export type IncidentStatusUpdate = z.infer<typeof incidentStatusUpdateSchema>;
export type IncidentNoteCreate = z.infer<typeof incidentNoteCreateSchema>;
