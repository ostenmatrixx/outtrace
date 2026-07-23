export type LogContext = Readonly<Record<string, unknown>>;

export interface Logger {
  info(event: string, context?: LogContext): void;
  warn(event: string, context?: LogContext): void;
  error(event: string, context?: LogContext): void;
}

export interface SafeError {
  [key: string]: unknown;
  errorName: string;
  errorMessage: string;
}

type LogLevel = 'info' | 'warn' | 'error';
type LogSink = (line: string) => void;

const SENSITIVE_KEY = /authorization|cookie|credential|password|payload|secret|token|url/i;
const REDIS_CREDENTIALS = /(rediss?:\/\/)([^@\s/]+)@/gi;
const QUERY_STRING = /([?&](?:key|password|secret|token)=)[^&\s]+/gi;

function sanitizeValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) {
    return '[REDACTED]';
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue('', item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [
        nestedKey,
        sanitizeValue(nestedKey, nestedValue),
      ]),
    );
  }

  if (typeof value === 'string') {
    return redactMessage(value);
  }

  return value;
}

function redactMessage(message: string): string {
  return message.replace(REDIS_CREDENTIALS, '$1[REDACTED]@').replace(QUERY_STRING, '$1[REDACTED]');
}

export function safeError(error: unknown): SafeError {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: redactMessage(error.message),
    };
  }

  return {
    errorName: 'UnknownError',
    errorMessage: 'An unknown error occurred',
  };
}

export function serializeLog(
  level: LogLevel,
  event: string,
  context: LogContext = {},
  now: () => Date = () => new Date(),
): string {
  const safeContext = Object.fromEntries(
    Object.entries(context).map(([key, value]) => [key, sanitizeValue(key, value)]),
  );

  return JSON.stringify({
    timestamp: now().toISOString(),
    level,
    service: 'openflow-worker',
    event,
    ...safeContext,
  });
}

export function createLogger(
  sink: LogSink = (line) => {
    process.stdout.write(`${line}\n`);
  },
): Logger {
  return {
    info: (event, context) => sink(serializeLog('info', event, context)),
    warn: (event, context) => sink(serializeLog('warn', event, context)),
    error: (event, context) => sink(serializeLog('error', event, context)),
  };
}
