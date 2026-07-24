import { z } from 'zod';

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
  slaSeconds: z.number().int().positive().nullable(),
  metadataAllowlist: z.array(z.string()),
});

export const processUpdateSchema = z
  .object({
    clientId: z.string().min(1).optional(),
    metadataAllowlist: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/))
      .max(32)
      .optional(),
  })
  .refine((value) => value.clientId !== undefined || value.metadataAllowlist !== undefined, {
    message: 'At least one process change is required.',
  });

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
export type ProcessUpdate = z.infer<typeof processUpdateSchema>;
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
export type ClientReliabilityReport = z.infer<typeof clientReliabilityReportSchema>;
