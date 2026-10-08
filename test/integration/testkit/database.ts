import { DataSource } from 'typeorm';
import { entities } from '../../../src/entities';

export function connect(): Promise<DataSource> {
  return new DataSource({
    type: 'postgres',
    url: process.env.TEST_DATABASE_URL,
    entities,
    extra: { max: 20 },
  }).initialize();
}

function assertTestContainer(dataSource: DataSource) {
  const options = dataSource.options as {
    url?: string;
    host?: string;
    port?: number;
    database?: string;
  };
  const target = options.url
    ? new URL(options.url)
    : new URL(`postgres://${options.host}:${options.port}/${options.database}`);
  const container = process.env.TEST_DATABASE_URL
    ? new URL(process.env.TEST_DATABASE_URL)
    : null;
  if (
    !container ||
    target.hostname !== container.hostname ||
    target.port !== container.port ||
    target.pathname !== container.pathname
  ) {
    throw new Error(
      `refusing to truncate ${target.host}${target.pathname}: it is not the test container`,
    );
  }
}

export async function resetDatabase(dataSource: DataSource) {
  assertTestContainer(dataSource);
  const tables = dataSource.entityMetadatas
    .map((meta) => `"${meta.tableName}"`)
    .join(', ');
  await dataSource.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

export function pgError(code: string) {
  return { driverError: { code } };
}
