export type ServiceState = 'loading' | 'up' | 'degraded' | 'down' | 'unavailable';

export interface ServiceHealth {
  name: 'API' | 'PostgreSQL' | 'Redis';
  state: ServiceState;
  detail: string;
}

export interface HealthSnapshot {
  overall: ServiceState;
  services: [ServiceHealth, ServiceHealth, ServiceHealth];
  checkedAt: Date | null;
  error: string | null;
}

const LOADING_SERVICES: HealthSnapshot['services'] = [
  {
    name: 'API',
    state: 'loading',
    detail: 'Waiting for the health endpoint to respond.',
  },
  {
    name: 'PostgreSQL',
    state: 'loading',
    detail: 'Database check is pending.',
  },
  {
    name: 'Redis',
    state: 'loading',
    detail: 'Queue dependency check is pending.',
  },
];

export const loadingSnapshot = (): HealthSnapshot => ({
  overall: 'loading',
  services: LOADING_SERVICES.map((service) => ({
    ...service,
  })) as HealthSnapshot['services'],
  checkedAt: null,
  error: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeState = (value: unknown): ServiceState => {
  const rawValue = isRecord(value) ? value.status : value;
  const state = typeof rawValue === 'string' ? rawValue.toLowerCase() : '';

  if (['up', 'ok', 'healthy', 'ready', 'connected'].includes(state)) {
    return 'up';
  }

  if (['degraded', 'partial'].includes(state)) {
    return 'degraded';
  }

  if (['down', 'error', 'failed', 'unhealthy', 'disconnected'].includes(state)) {
    return 'down';
  }

  return 'unavailable';
};

const findDependency = (payload: Record<string, unknown>, aliases: string[]): unknown => {
  const containers = [payload.dependencies, payload.checks, payload.services, payload];

  for (const container of containers) {
    if (!isRecord(container)) {
      continue;
    }

    for (const alias of aliases) {
      if (alias in container) {
        return container[alias];
      }
    }
  }

  return undefined;
};

const dependencyDetail = (name: 'PostgreSQL' | 'Redis', state: ServiceState): string => {
  if (state === 'up') {
    return name === 'PostgreSQL'
      ? 'Connection check passed; persistence is reachable.'
      : 'Connection check passed; queue infrastructure is reachable.';
  }

  if (state === 'degraded') {
    return `${name} reported a degraded connection.`;
  }

  if (state === 'down') {
    return `${name} did not pass its connection check.`;
  }

  return `${name} status was not included in the health response.`;
};

export const parseHealthPayload = (payload: unknown, checkedAt = new Date()): HealthSnapshot => {
  const record = isRecord(payload) ? payload : {};
  const postgresState = normalizeState(
    findDependency(record, ['postgresql', 'postgres', 'database']),
  );
  const redisState = normalizeState(findDependency(record, ['redis', 'queue']));
  const dependencyStates = [postgresState, redisState];
  const overall = dependencyStates.every((state) => state === 'up') ? 'up' : 'degraded';

  return {
    overall,
    services: [
      {
        name: 'API',
        state: 'up',
        detail: 'Health endpoint responded successfully.',
      },
      {
        name: 'PostgreSQL',
        state: postgresState,
        detail: dependencyDetail('PostgreSQL', postgresState),
      },
      {
        name: 'Redis',
        state: redisState,
        detail: dependencyDetail('Redis', redisState),
      },
    ],
    checkedAt,
    error: null,
  };
};

export const unavailableSnapshot = (message: string): HealthSnapshot => ({
  overall: 'down',
  services: [
    {
      name: 'API',
      state: 'down',
      detail: 'The configured health endpoint could not be reached.',
    },
    {
      name: 'PostgreSQL',
      state: 'unavailable',
      detail: 'Not checked because the API is unavailable.',
    },
    {
      name: 'Redis',
      state: 'unavailable',
      detail: 'Not checked because the API is unavailable.',
    },
  ],
  checkedAt: null,
  error: message,
});
