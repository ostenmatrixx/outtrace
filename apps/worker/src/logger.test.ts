import { describe, expect, it } from 'vitest';

import { safeError, safeErrorMessage, serializeLog } from './logger.js';

describe('safe logging', () => {
  it('produces structured service logs and redacts sensitive fields recursively', () => {
    const line = serializeLog(
      'error',
      'job_failed',
      {
        jobId: 'job_1',
        payload: { customerEmail: 'person@example.com' },
        nested: { apiToken: 'token-value', attempt: 2 },
      },
      () => new Date('2026-07-23T00:00:00.000Z'),
    );

    expect(JSON.parse(line)).toEqual({
      timestamp: '2026-07-23T00:00:00.000Z',
      level: 'error',
      service: 'outtrace-worker',
      event: 'job_failed',
      jobId: 'job_1',
      payload: '[REDACTED]',
      nested: { apiToken: '[REDACTED]', attempt: 2 },
    });
    expect(line).not.toContain('person@example.com');
    expect(line).not.toContain('token-value');
  });

  it('removes Redis credentials from error messages', () => {
    expect(
      safeError(new Error('Could not connect to redis://worker:secret@redis.example.com:6379')),
    ).toEqual({
      errorName: 'Error',
      errorMessage: 'Could not connect to redis://[REDACTED]@redis.example.com:6379',
    });
    expect(safeErrorMessage('Request failed?token=super-secret&attempt=2')).toBe(
      'Request failed?token=[REDACTED]&attempt=2',
    );
    expect(safeErrorMessage('postgres://worker:secret@db.example.com/outtrace failed')).toBe(
      'postgres://[REDACTED]@db.example.com/outtrace failed',
    );
  });
});
