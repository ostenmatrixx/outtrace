import { describe, expect, it } from 'vitest';

import { processIncidentEvaluationJob, validateIncidentEvaluationJob } from './processor.js';

const validJob = {
  workspaceId: 'workspace_1',
  processInstanceId: 'instance_1',
  eventId: 'event_1',
};

describe('incident evaluation processor', () => {
  it('validates a shared-contract job and strips unknown fields', () => {
    expect(validateIncidentEvaluationJob({ ...validJob, secret: 'discard-me' })).toEqual(validJob);
  });

  it('rejects malformed jobs before processing', async () => {
    await expect(
      processIncidentEvaluationJob({
        workspaceId: '',
        processInstanceId: 'instance_1',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('returns the inspectable Phase 1 no-op result', async () => {
    await expect(processIncidentEvaluationJob(validJob)).resolves.toEqual({
      evaluated: false,
      reason: 'phase_2_not_implemented',
    });
  });
});
