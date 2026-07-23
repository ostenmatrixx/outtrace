import { createClient } from 'redis';

export interface RedisConnection {
  close(): Promise<void>;
  ping(): Promise<string>;
}

export class ProductionRedisConnection implements RedisConnection {
  private readonly client;
  private connecting: Promise<void> | undefined;

  constructor(url: string) {
    this.client = createClient({
      url,
      socket: {
        connectTimeout: 2_000,
        reconnectStrategy: false,
      },
    });
    this.client.on('error', () => {
      // Availability is exposed by /health; connection errors never include the Redis URL in logs.
    });
  }

  async ping(): Promise<string> {
    if (!this.client.isOpen) {
      this.connecting ??= this.client
        .connect()
        .then(() => undefined)
        .finally(() => {
          this.connecting = undefined;
        });
      await this.connecting;
    }

    return this.client.ping();
  }

  async close(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }
}
