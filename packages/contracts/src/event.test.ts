import { describe, expect, it } from 'vitest';

import { ingestEventSchema } from './event.js';

const baseEvent = {
  eventId: 'evt_01JZ5A8W9TQXM2YF7K3N6R4P1C',
  processKey: 'client-onboarding',
  instanceKey: 'customer_4821',
  stage: 'workspace_created',
  status: 'completed',
  source: 'n8n',
  occurredAt: '2026-07-23T10:30:00Z',
  metadata: {
    clientId: 'client_acme',
  },
};

describe('ingestEventSchema', () => {
  it.each(['n8n', 'make', 'custom'] as const)('accepts the %s source', (source) => {
    expect(ingestEventSchema.parse({ ...baseEvent, source }).source).toBe(source);
  });

  it('removes unknown top-level fields', () => {
    const parsed = ingestEventSchema.parse({ ...baseEvent, arbitraryPayload: 'discard me' });

    expect(parsed).not.toHaveProperty('arbitraryPayload');
  });

  it('rejects unsupported statuses', () => {
    expect(() => ingestEventSchema.parse({ ...baseEvent, status: 'waiting' })).toThrow();
  });
});
