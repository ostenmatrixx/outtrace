import { describe, expect, it } from 'vitest';

import { memberInviteSchema, processUpdateSchema, workspaceSettingsSchema } from './agency.js';

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

  it('bounds retention controls', () => {
    expect(workspaceSettingsSchema.parse({ eventRetentionDays: 30 })).toEqual({
      eventRetentionDays: 30,
    });
    expect(workspaceSettingsSchema.safeParse({ eventRetentionDays: 0 }).success).toBe(false);
  });
});
