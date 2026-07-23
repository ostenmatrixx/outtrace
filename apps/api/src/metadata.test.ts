import { describe, expect, it } from 'vitest';

import { redactSensitiveMetadata, sanitizeMetadata } from './metadata.js';

describe('sanitizeMetadata', () => {
  it('removes metadata outside the allowlist', () => {
    expect(
      sanitizeMetadata({
        clientId: 'client_acme',
        customerEmail: 'private@example.com',
        executionId: 'run_1',
      }),
    ).toEqual({
      clientId: 'client_acme',
      executionId: 'run_1',
    });
  });

  it('recursively redacts sensitive nested keys case-insensitively before allowlisting', () => {
    expect(
      redactSensitiveMetadata({
        environment: {
          apiKeyBackup: 'secret-1',
          nested: [
            {
              AuthorizationHeader: 'Bearer secret-2',
              safe: true,
              user_session_id: 'session-1',
            },
          ],
          Password: 'secret-3',
        },
      }),
    ).toEqual({
      environment: {
        apiKeyBackup: '[REDACTED]',
        nested: [
          {
            AuthorizationHeader: '[REDACTED]',
            safe: true,
            user_session_id: '[REDACTED]',
          },
        ],
        Password: '[REDACTED]',
      },
    });
  });

  it('persists only bounded scalar strings and valid HTTP(S) execution URLs', () => {
    expect(
      sanitizeMetadata({
        clientId: { nested: 'discarded' },
        environment: ['discarded'],
        executionId: 'x'.repeat(256),
        executionUrl: 'javascript:alert(1)',
        externalReference: 'reference-1',
        region: 'us-east-1',
      }),
    ).toEqual({
      externalReference: 'reference-1',
      region: 'us-east-1',
    });

    expect(
      sanitizeMetadata({
        executionUrl: 'https://n8n.example.com/execution/9281',
      }),
    ).toEqual({
      executionUrl: 'https://n8n.example.com/execution/9281',
    });
  });
});
