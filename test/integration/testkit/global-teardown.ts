import { rmSync } from 'node:fs';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export default async function globalTeardown() {
  const state = (
    globalThis as {
      __TEST_DATABASE__?: {
        container: StartedPostgreSqlContainer;
        secretDir: string;
      };
    }
  ).__TEST_DATABASE__;
  if (!state) return;
  await state.container.stop();
  rmSync(state.secretDir, { recursive: true, force: true });
}
