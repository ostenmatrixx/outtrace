import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { vi } from 'vitest';

import { processIncidentEvaluationJob, validateIncidentEvaluationJob } from './processor.js';

const validJob = {
  workspaceId: 'workspace_1',
  processInstanceId: 'instance_1',
  eventId: 'event_1',
};
const pool = {} as pg.Pool;

describe('incident evaluation processor', () => {
  it('validates a shared-contract job and strips unknown fields', () => {
    expect(validateIncidentEvaluationJob({ ...validJob, secret: 'discard-me' })).toEqual({
      ...validJob,
      reason: 'event',
    });
  });

  it('rejects malformed jobs before processing', async () => {
    await expect(
      processIncidentEvaluationJob(pool, {
        workspaceId: '',
        processInstanceId: 'instance_1',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('evaluates a validated process instance', async () => {
    const evaluate = vi.fn(async () => ({
      evaluated: true as const,
      created: 1,
      reopened: 0,
      resolved: 0,
      active: 1,
    }));

    await expect(processIncidentEvaluationJob(pool, validJob, evaluate)).resolves.toMatchObject({
      evaluated: true,
      created: 1,
    });
    expect(evaluate).toHaveBeenCalledWith(pool, 'workspace_1', 'instance_1');
  });
});
