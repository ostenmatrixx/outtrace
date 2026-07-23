const metadataValueLimits = {
  clientId: 255,
  environment: 100,
  executionId: 255,
  executionUrl: 2_048,
  externalReference: 512,
  region: 100,
} as const;

export const MAX_METADATA_TOTAL_BYTES = 4_096;

const sensitiveKeyPattern = /password|passwd|token|secret|authorization|api[_]?key|cookie|session/i;

export function redactSensitiveMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveMetadata);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        sensitiveKeyPattern.test(key) ? '[REDACTED]' : redactSensitiveMetadata(nestedValue),
      ]),
    );
  }

  return value;
}

function isAllowedExecutionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, string> {
  const redacted = redactSensitiveMetadata(metadata);
  if (redacted === null || typeof redacted !== 'object' || Array.isArray(redacted)) {
    return {};
  }

  const sanitized: Record<string, string> = {};
  let totalBytes = 0;

  for (const [key, maximumLength] of Object.entries(metadataValueLimits)) {
    const value = (redacted as Record<string, unknown>)[key];
    if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
      continue;
    }
    if (key === 'executionUrl' && !isAllowedExecutionUrl(value)) {
      continue;
    }

    const entryBytes = Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8');
    if (totalBytes + entryBytes > MAX_METADATA_TOTAL_BYTES) {
      continue;
    }

    sanitized[key] = value;
    totalBytes += entryBytes;
  }

  return sanitized;
}

export function isSensitiveMetadataKey(key: string): boolean {
  return sensitiveKeyPattern.test(key);
}
