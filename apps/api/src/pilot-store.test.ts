import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { getPilotSummary } from './pilot-store.js';

function pilotPool(queries: string[] = []): pg.Pool {
  return {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes('percentile_cont')) {
        return {
          rowCount: 1,
          rows: [{ connected: 1, median_seconds_to_first_event: '300', total: 2 }],
        };
      }
      if (sql.includes('FROM incidents')) {
        return {
          rowCount: 1,
          rows: [{ false_positive: 1, genuine: 3, total: 5 }],
        };
      }
      return {
        rowCount: 1,
        rows: [
          {
            client_id: 'client_1',
            client_name: 'Acme',
            connected_at: new Date('2026-07-20T00:05:00.000Z'),
            event_count: 12,
            id: 'process_1',
            key: 'onboarding',
            last_event_received_at: new Date('2026-07-24T00:00:00.000Z'),
            name: 'Onboarding',
          },
        ],
      };
    },
  } as unknown as pg.Pool;
}

describe('getPilotSummary', () => {
  it('maps the fixed 28-day activation and quality metrics with explicit denominators', async () => {
    const queries: string[] = [];
    const summary = await getPilotSummary(
      pilotPool(queries),
      'workspace_1',
      new Date('2026-07-25T00:00:00.000Z'),
    );

    expect(summary).toMatchObject({
      windowDays: 28,
      windowStartedAt: '2026-06-27T00:00:00.000Z',
      generatedAt: '2026-07-25T00:00:00.000Z',
      activation: {
        totalProcesses: 2,
        connectedProcesses: 1,
        awaitingFirstEvent: 1,
        connectionRate: 0.5,
        medianSecondsToFirstEvent: 300,
      },
      quality: {
        incidentsDetected: 5,
        reviewedIncidents: 4,
        genuineIncidents: 3,
        falsePositiveIncidents: 1,
        unreviewedIncidents: 1,
        falsePositiveRate: 0.25,
      },
      processes: [
        {
          id: 'process_1',
          connectionStatus: 'connected',
          eventCount: 12,
        },
      ],
    });
    expect(queries.find((query) => query.includes('FROM incidents'))).toContain(
      "processes.environment = 'production'",
    );
  });
});
