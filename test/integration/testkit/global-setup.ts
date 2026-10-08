import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { entities } from '../../../src/entities';

const POSTGRES_IMAGE = 'postgres:16-alpine';

export default async function globalSetup() {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();

  const dataSource = new DataSource({
    type: 'postgres',
    url: container.getConnectionUri(),
    entities,
    migrations: [join(process.cwd(), 'src', 'migrations', '*.ts')],
  });
  await dataSource.initialize();
  await dataSource.runMigrations();
  await dataSource.destroy();

  const secretDir = mkdtempSync(join(tmpdir(), 'marketplace-test-'));
  const secretFile = join(secretDir, 'db_password');
  writeFileSync(
    secretFile,
    `${container.getUsername()}:${container.getPassword()}`,
  );

  process.env.TEST_DATABASE_URL = container.getConnectionUri();
  process.env.DB_URL = `postgres://${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
  process.env.DB_PASSWORD_FILE = secretFile;
  Object.assign(globalThis, { __TEST_DATABASE__: { container, secretDir } });
}
