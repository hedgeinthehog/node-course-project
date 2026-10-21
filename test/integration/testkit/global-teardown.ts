import { rmSync } from 'node:fs';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRabbitMQContainer } from '@testcontainers/rabbitmq';

export default async function globalTeardown() {
  const state = (
    globalThis as {
      __TEST_DATABASE__?: {
        container: StartedPostgreSqlContainer;
        broker: StartedRabbitMQContainer;
        secretDir: string;
      };
    }
  ).__TEST_DATABASE__;
  if (!state) return;
  await Promise.all([state.container.stop(), state.broker.stop()]);
  rmSync(state.secretDir, { recursive: true, force: true });
}
