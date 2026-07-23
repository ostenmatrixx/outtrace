import { z } from 'zod';

export const eventStatuses = ['started', 'completed', 'failed'] as const;
export const eventSources = ['n8n', 'make', 'custom'] as const;

const identifierSchema = z.string().trim().min(1).max(255);

export const eventMetadataSchema = z.record(z.string(), z.unknown());

export const ingestEventSchema = z
  .object({
    eventId: identifierSchema,
    processKey: identifierSchema,
    instanceKey: identifierSchema,
    stage: identifierSchema,
    status: z.enum(eventStatuses),
    source: z.enum(eventSources),
    occurredAt: z.iso.datetime({ offset: true }),
    metadata: eventMetadataSchema.optional().default({}),
  })
  .strip();

export const ingestEventResponseSchema = z.object({
  eventId: z.string(),
  processInstanceId: z.string(),
  accepted: z.literal(true),
  duplicate: z.boolean(),
});

export type EventStatus = (typeof eventStatuses)[number];
export type EventSource = (typeof eventSources)[number];
export type IngestEvent = z.infer<typeof ingestEventSchema>;
export type IngestEventResponse = z.infer<typeof ingestEventResponseSchema>;
