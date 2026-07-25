import { describe, expect, it } from 'vitest';

import { incidentFeedbackUpdateSchema } from './pilot.js';

describe('pilot contracts', () => {
  it('requires a reason only for false-positive classifications', () => {
    expect(incidentFeedbackUpdateSchema.safeParse({ verdict: 'false_positive' }).success).toBe(
      false,
    );
    expect(
      incidentFeedbackUpdateSchema.parse({
        verdict: 'false_positive',
        reason: 'timeout_too_short',
      }),
    ).toMatchObject({ verdict: 'false_positive', reason: 'timeout_too_short' });
    expect(
      incidentFeedbackUpdateSchema.safeParse({
        verdict: 'genuine',
        reason: 'timeout_too_short',
      }).success,
    ).toBe(false);
  });
});
