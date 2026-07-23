import { describe, expect, it } from 'vitest';

import { apiErrorSchema } from './errors.js';

describe('apiErrorSchema', () => {
  it('represents the structured ingestion rate-limit response', () => {
    expect(
      apiErrorSchema.parse({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many event ingestion requests. Please retry later.',
        },
      }),
    ).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many event ingestion requests. Please retry later.',
      },
    });
  });
});
