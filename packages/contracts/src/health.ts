import { z } from 'zod';

const dependencyHealthSchema = z.object({
  status: z.enum(['up', 'down']),
});

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.string(),
  dependencies: z.object({
    postgres: dependencyHealthSchema,
    redis: dependencyHealthSchema,
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
