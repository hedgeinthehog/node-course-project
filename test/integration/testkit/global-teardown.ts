import { rmSync } from 'node:fs';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import type { StartedTestContainer } from 'testcontainers';

export default async function globalTeardown() {
  const state = (
    globalThis as {
      __TEST_DATABASE__?: {
        container: StartedPostgreSqlContainer;
        broker: StartedRabbitMQContainer;
        redis: StartedTestContainer;
        minio: StartedTestContainer;
        secretDir: string;
      };
    }
  ).__TEST_DATABASE__;
  if (!state) return;
  await Promise.all([
    state.container.stop(),
    state.broker.stop(),
    state.redis.stop(),
    state.minio.stop(),
  ]);
  rmSync(state.secretDir, { recursive: true, force: true });
}
