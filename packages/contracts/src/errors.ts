import { z } from 'zod';

export const apiErrorCodes = [
  'AUTHENTICATION_REQUIRED',
  'AUTHENTICATION_INVALID',
  'INVALID_PAYLOAD',
  'UNKNOWN_PROCESS',
  'UNSUPPORTED_STATUS',
  'RATE_LIMITED',
  'DATABASE_FAILURE',
  'INTERNAL_ERROR',
] as const;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(apiErrorCodes),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ApiErrorCode = (typeof apiErrorCodes)[number];
export type ApiError = z.infer<typeof apiErrorSchema>;
