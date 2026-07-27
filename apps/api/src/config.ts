import { readFileSync } from 'node:fs';

import { z } from 'zod';

const booleanFromEnvironment = z
  .enum(['true', 'false'])
  .optional()
  .default('false')
  .transform((value) => value === 'true');

const dependencyUrl = (protocols: string[], label: string) =>
  z
    .string()
    .url()
    .refine((value) => protocols.includes(new URL(value).protocol), {
      message: `${label} must use ${protocols.join(' or ')}`,
    });

const configSchema = z
  .object({
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    API_CORS_ORIGIN: z
      .string()
      .url()
      .refine((value) => new URL(value).origin === value, {
        message: 'API_CORS_ORIGIN must be an exact origin without a path, query, or trailing slash',
      })
      .default('http://localhost:5173'),
    API_TRUST_PROXY: booleanFromEnvironment,
    DATABASE_URL: dependencyUrl(['postgres:', 'postgresql:'], 'DATABASE_URL'),
    REDIS_URL: dependencyUrl(['redis:', 'rediss:'], 'REDIS_URL'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    OUTTRACE_SEED_DEVELOPMENT: booleanFromEnvironment,
    DEV_INGESTION_KEY_ID: z.string().min(1).optional(),
    DEV_INGESTION_KEY: z.string().min(1).optional(),
    DEV_OPERATOR_KEY_ID: z.string().min(1).optional(),
    DEV_OPERATOR_KEY: z.string().min(1).optional(),
    DEV_WORKSPACE_ID: z.string().min(1).optional(),
    DEV_CLIENT_ID: z.string().min(1).optional(),
    DEV_PROCESS_ID: z.string().min(1).optional(),
    DEV_PROCESS_KEY: z.string().min(1).optional(),
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV === 'production') {
      const databaseUrl = new URL(environment.DATABASE_URL);
      if (databaseUrl.searchParams.get('sslmode') !== 'verify-full') {
        context.addIssue({
          code: 'custom',
          message: 'DATABASE_URL must use sslmode=verify-full in production',
          path: ['DATABASE_URL'],
        });
      }
      if (new URL(environment.REDIS_URL).protocol !== 'rediss:') {
        context.addIssue({
          code: 'custom',
          message: 'REDIS_URL must use rediss:// in production',
          path: ['REDIS_URL'],
        });
      }
      if (new URL(environment.API_CORS_ORIGIN).protocol !== 'https:') {
        context.addIssue({
          code: 'custom',
          message: 'API_CORS_ORIGIN must use HTTPS in production',
          path: ['API_CORS_ORIGIN'],
        });
      }
    }

    if (!environment.OUTTRACE_SEED_DEVELOPMENT) {
      return;
    }

    if (environment.NODE_ENV === 'production') {
      context.addIssue({
        code: 'custom',
        message: 'OUTTRACE_SEED_DEVELOPMENT cannot be enabled in production',
        path: ['OUTTRACE_SEED_DEVELOPMENT'],
      });
    }

    const requiredSeedValues = [
      'DEV_INGESTION_KEY_ID',
      'DEV_INGESTION_KEY',
      'DEV_OPERATOR_KEY_ID',
      'DEV_OPERATOR_KEY',
      'DEV_WORKSPACE_ID',
      'DEV_CLIENT_ID',
      'DEV_PROCESS_ID',
      'DEV_PROCESS_KEY',
    ] as const;

    for (const key of requiredSeedValues) {
      if (!environment[key]) {
        context.addIssue({
          code: 'custom',
          message: `${key} is required when OUTTRACE_SEED_DEVELOPMENT=true`,
          path: [key],
        });
      }
    }
  });

export interface DevelopmentSeedConfig {
  clientId: string;
  ingestionKey: string;
  ingestionKeyId: string;
  operatorKey: string;
  operatorKeyId: string;
  processId: string;
  processKey: string;
  workspaceId: string;
}

export interface ApiConfig {
  allowLegacyWorkspaceCredentials: boolean;
  corsOrigin: string;
  databaseUrl: string;
  developmentSeed?: DevelopmentSeedConfig;
  host: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  nodeEnvironment: 'development' | 'test' | 'production';
  port: number;
  redisUrl: string;
  trustProxy: boolean;
}

export class ConfigurationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid API configuration: ${issues.join('; ')}`);
    this.name = 'ConfigurationError';
  }
}

function resolveSecret(
  environment: NodeJS.ProcessEnv,
  name: 'DATABASE_URL' | 'REDIS_URL',
): string | undefined {
  const direct = environment[name]?.trim();
  const file = environment[`${name}_FILE`]?.trim();
  if (direct && file) {
    throw new ConfigurationError([`${name} and ${name}_FILE cannot both be set`]);
  }
  if (!file) return direct;
  try {
    const value = readFileSync(file, 'utf8').trim();
    if (!value) throw new Error('empty secret');
    return value;
  } catch {
    throw new ConfigurationError([`${name}_FILE could not be read`]);
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const resolvedEnvironment = {
    ...environment,
    DATABASE_URL: resolveSecret(environment, 'DATABASE_URL'),
    REDIS_URL: resolveSecret(environment, 'REDIS_URL'),
  };
  const result = configSchema.safeParse(resolvedEnvironment);

  if (!result.success) {
    throw new ConfigurationError(
      result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message}`;
      }),
    );
  }

  const value = result.data;
  const developmentSeed = value.OUTTRACE_SEED_DEVELOPMENT
    ? {
        clientId: value.DEV_CLIENT_ID!,
        ingestionKey: value.DEV_INGESTION_KEY!,
        ingestionKeyId: value.DEV_INGESTION_KEY_ID!,
        operatorKey: value.DEV_OPERATOR_KEY!,
        operatorKeyId: value.DEV_OPERATOR_KEY_ID!,
        processId: value.DEV_PROCESS_ID!,
        processKey: value.DEV_PROCESS_KEY!,
        workspaceId: value.DEV_WORKSPACE_ID!,
      }
    : undefined;

  return {
    allowLegacyWorkspaceCredentials: value.NODE_ENV !== 'production',
    corsOrigin: value.API_CORS_ORIGIN,
    databaseUrl: value.DATABASE_URL,
    ...(developmentSeed ? { developmentSeed } : {}),
    host: value.API_HOST,
    logLevel: value.LOG_LEVEL,
    nodeEnvironment: value.NODE_ENV,
    port: value.API_PORT,
    redisUrl: value.REDIS_URL,
    trustProxy: value.API_TRUST_PROXY,
  };
}
