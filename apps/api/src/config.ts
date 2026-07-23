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
    API_CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
    DATABASE_URL: dependencyUrl(['postgres:', 'postgresql:'], 'DATABASE_URL'),
    REDIS_URL: dependencyUrl(['redis:', 'rediss:'], 'REDIS_URL'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    OUTTRACE_SEED_DEVELOPMENT: booleanFromEnvironment,
    DEV_INGESTION_KEY_ID: z.string().min(1).optional(),
    DEV_INGESTION_KEY: z.string().min(1).optional(),
    DEV_WORKSPACE_ID: z.string().min(1).optional(),
    DEV_CLIENT_ID: z.string().min(1).optional(),
    DEV_PROCESS_ID: z.string().min(1).optional(),
    DEV_PROCESS_KEY: z.string().min(1).optional(),
  })
  .superRefine((environment, context) => {
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
  processId: string;
  processKey: string;
  workspaceId: string;
}

export interface ApiConfig {
  corsOrigin: string;
  databaseUrl: string;
  developmentSeed?: DevelopmentSeedConfig;
  host: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  nodeEnvironment: 'development' | 'test' | 'production';
  port: number;
  redisUrl: string;
}

export class ConfigurationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid API configuration: ${issues.join('; ')}`);
    this.name = 'ConfigurationError';
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const result = configSchema.safeParse(environment);

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
        processId: value.DEV_PROCESS_ID!,
        processKey: value.DEV_PROCESS_KEY!,
        workspaceId: value.DEV_WORKSPACE_ID!,
      }
    : undefined;

  return {
    corsOrigin: value.API_CORS_ORIGIN,
    databaseUrl: value.DATABASE_URL,
    ...(developmentSeed ? { developmentSeed } : {}),
    host: value.API_HOST,
    logLevel: value.LOG_LEVEL,
    nodeEnvironment: value.NODE_ENV,
    port: value.API_PORT,
    redisUrl: value.REDIS_URL,
  };
}
