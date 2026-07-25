import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProcessCredential } from './pilot';

const mockFetch = vi.fn<typeof fetch>();

afterEach(() => {
  vi.unstubAllGlobals();
  mockFetch.mockReset();
});

describe('pilot API', () => {
  it('creates a process-scoped ingestion credential with operator authentication', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          processId: 'process_1',
          keyId: 'ing_process_1',
          key: 'shown_once',
          createdAt: '2026-07-24T01:00:00.000Z',
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      createProcessCredential(
        'https://api.outtrace.test',
        { keyId: 'operator_1', key: 'operator_secret', name: 'Mina' },
        'process_1',
      ),
    ).resolves.toMatchObject({
      processId: 'process_1',
      keyId: 'ing_process_1',
      key: 'shown_once',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.outtrace.test/v1/processes/process_1/credentials',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-outtrace-operator-key-id': 'operator_1',
          'x-outtrace-operator-name': 'Mina',
        }),
      }),
    );
  });
});
