import { describe, expect, it } from 'vitest';

import {
  memberInviteSchema,
  processCreateSchema,
  processUpdateSchema,
  workspaceSettingsSchema,
} from './agency.js';

describe('agency support contracts', () => {
  it('validates role invitations and defaults unrestricted client IDs', () => {
    expect(
      memberInviteSchema.parse({
        name: 'Mina',
        email: 'mina@example.com',
        role: 'operator',
      }),
    ).toMatchObject({ role: 'operator', clientIds: [] });
  });

  it('bounds metadata allowlists to safe top-level identifiers', () => {
    expect(
      processUpdateSchema.parse({ metadataAllowlist: ['orderId', 'executionUrl'] }),
    ).toMatchObject({ metadataAllowlist: ['orderId', 'executionUrl'] });
    expect(processUpdateSchema.safeParse({ metadataAllowlist: ['customer.email'] }).success).toBe(
      false,
    );
  });

  it('validates an ordered production process definition', () => {
    const input = {
      clientId: 'client_acme',
      key: 'client-onboarding',
      name: 'Client onboarding',
      slaSeconds: 1_800,
      metadataAllowlist: ['executionUrl'],
      stages: [
        {
          key: 'payment_received',
          name: 'Payment received',
          source: 'make',
          timeoutSeconds: 300,
        },
        {
          key: 'account_created',
          name: 'Account created',
          source: 'custom',
          timeoutSeconds: 600,
        },
      ],
    };

    expect(processCreateSchema.parse(input).stages).toHaveLength(2);
    expect(
      processCreateSchema.safeParse({
        ...input,
        stages: [input.stages[0], input.stages[0]],
      }).success,
    ).toBe(false);
  });

  it('bounds retention controls', () => {
    expect(workspaceSettingsSchema.parse({ eventRetentionDays: 30 })).toEqual({
      eventRetentionDays: 30,
    });
    expect(workspaceSettingsSchema.safeParse({ eventRetentionDays: 0 }).success).toBe(false);
  });
});
