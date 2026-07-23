import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { createPool } from './database.js';
import { runMigrations } from './migrations.js';

export async function migrate(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);

  try {
    const migrations = await runMigrations(pool, {
      ...(config.developmentSeed ? { seed: config.developmentSeed } : {}),
    });
    const message =
      migrations.length === 0
        ? 'Database is already up to date.'
        : `Applied migrations: ${migrations.join(', ')}`;
    process.stdout.write(`${message}\n`);
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  migrate().catch(() => {
    process.stderr.write(
      'Database migration failed. Check database connectivity and migration files.\n',
    );
    process.exitCode = 1;
  });
}
