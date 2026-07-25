import { z } from 'zod';

import { eventSources } from './event.js';

export const workspaceRoles = ['owner', 'operator', 'viewer'] as const;
export const workspaceRoleSchema = z.enum(workspaceRoles);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const operatorSessionSchema = z.object({
  workspaceId: z.string().min(1),
  memberId: z.string().nullable(),
  name: z.string().min(1),
  role: workspaceRoleSchema,
  clientIds: z.array(z.string()).nullable(),
});

export const clientSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  processCount: z.number().int().nonnegative(),
  openIncidentCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});

export const clientCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

export const memberSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.email(),
  role: workspaceRoleSchema,
  status: z.enum(['invited', 'active', 'disabled']),
  clientIds: z.array(z.string()),
  createdAt: z.iso.datetime(),
});

export const memberInviteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email(),
  role: workspaceRoleSchema,
  clientIds: z.array(z.string().min(1)).max(200).default([]),
});

export const memberUpdateSchema = z
  .object({
    role: workspaceRoleSchema.optional(),
    status: z.enum(['active', 'disabled']).optional(),
    clientIds: z.array(z.string().min(1)).max(200).optional(),
  })
  .refine(
    (value) =>
      value.role !== undefined || value.status !== undefined || value.clientIds !== undefined,
    { message: 'At least one member change is required.' },
  );

export const memberInviteResponseSchema = z.object({
  member: memberSummarySchema,
  accessKeyId: z.string().min(1),
  accessKey: z.string().min(1),
});

export const processSummarySchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  name: z.string().min(1),
  clientId: z.string().min(1),
  clientName: z.string().min(1),
  environment: z.enum(['sandbox', 'production']),
  lifecycleStatus: z.enum(['active', 'archived']),
  slaSeconds: z.number().int().positive().nullable(),
  metadataAllowlist: z.array(z.string()),
  stageCount: z.number().int().nonnegative(),
  connectionStatus: z.enum(['awaiting_first_event', 'connected']),
  eventCount: z.number().int().nonnegative(),
  connectedAt: z.iso.datetime().nullable(),
  lastEventAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

const metadataAllowlistSchema = z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)).max(32);

export const processStageCreateSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().trim().min(1).max(120),
  required: z.boolean().default(true),
  timeoutSeconds: z.number().int().min(30).max(2_592_000).nullable().default(null),
  source: z.enum(eventSources).nullable().default(null),
  owningTeam: z.string().trim().min(1).max(120).nullable().default(null),
});

export const processCreateSchema = z
  .object({
    clientId: z.string().min(1).max(200),
    key: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/),
    name: z.string().trim().min(1).max(200),
    environment: z.enum(['sandbox', 'production']).default('production'),
    slaSeconds: z.number().int().min(60).max(2_592_000).nullable().default(null),
    metadataAllowlist: metadataAllowlistSchema.default([]),
    stages: z.array(processStageCreateSchema).min(1).max(32),
  })
  .superRefine((value, context) => {
    const keys = new Set<string>();
    value.stages.forEach((stage, index) => {
      if (keys.has(stage.key)) {
        context.addIssue({
          code: 'custom',
          message: 'Stage keys must be unique within a process.',
          path: ['stages', index, 'key'],
        });
      }
      keys.add(stage.key);
    });
    if (!value.stages.some((stage) => stage.required)) {
      context.addIssue({
        code: 'custom',
        message: 'At least one process stage must be required.',
        path: ['stages'],
      });
    }
  });

export const processStageSchema = processStageCreateSchema.extend({
  id: z.string().min(1),
  position: z.number().int().nonnegative(),
});

export const processIngestionCredentialSchema = z.object({
  keyId: z.string().min(1),
  key: z.string().min(1),
  createdAt: z.iso.datetime(),
});

export const processCreateResponseSchema = z.object({
  process: processSummarySchema,
  stages: z.array(processStageSchema),
  credential: processIngestionCredentialSchema,
});

export const processCredentialResponseSchema = processIngestionCredentialSchema.extend({
  processId: z.string().min(1),
});

export const processUpdateSchema = z
  .object({
    clientId: z.string().min(1).optional(),
    lifecycleStatus: z.enum(['active', 'archived']).optional(),
    metadataAllowlist: metadataAllowlistSchema.optional(),
  })
  .refine(
    (value) =>
      value.clientId !== undefined ||
      value.lifecycleStatus !== undefined ||
      value.metadataAllowlist !== undefined,
    {
      message: 'At least one process change is required.',
    },
  );

export const workspaceSettingsSchema = z.object({
  eventRetentionDays: z.number().int().min(1).max(3650),
});

export const clientReliabilityReportSchema = z.object({
  client: z.object({ id: z.string(), name: z.string() }),
  totalInstances: z.number().int().nonnegative(),
  completedInstances: z.number().int().nonnegative(),
  completionRate: z.number().min(0).max(1),
  incidentsDetected: z.number().int().nonnegative(),
  incidentsResolved: z.number().int().nonnegative(),
  medianResolutionSeconds: z.number().nonnegative().nullable(),
  mostUnreliableStage: z
    .object({
      stage: z.string(),
      incidentCount: z.number().int().positive(),
    })
    .nullable(),
});

export type OperatorSession = z.infer<typeof operatorSessionSchema>;
export type ClientSummary = z.infer<typeof clientSummarySchema>;
export type ClientCreate = z.infer<typeof clientCreateSchema>;
export type MemberSummary = z.infer<typeof memberSummarySchema>;
export type MemberInvite = z.infer<typeof memberInviteSchema>;
export type MemberUpdate = z.infer<typeof memberUpdateSchema>;
export type MemberInviteResponse = z.infer<typeof memberInviteResponseSchema>;
export type ProcessSummary = z.infer<typeof processSummarySchema>;
export type ProcessStageCreate = z.infer<typeof processStageCreateSchema>;
export type ProcessCreate = z.infer<typeof processCreateSchema>;
export type ProcessStage = z.infer<typeof processStageSchema>;
export type ProcessIngestionCredential = z.infer<typeof processIngestionCredentialSchema>;
export type ProcessCreateResponse = z.infer<typeof processCreateResponseSchema>;
export type ProcessCredentialResponse = z.infer<typeof processCredentialResponseSchema>;
export type ProcessUpdate = z.infer<typeof processUpdateSchema>;
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
export type ClientReliabilityReport = z.infer<typeof clientReliabilityReportSchema>;
