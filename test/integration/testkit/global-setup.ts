import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';
import { GenericContainer, Wait } from 'testcontainers';
import amqp from 'amqplib';
import { DataSource } from 'typeorm';
import { entities } from '../../../src/entities';
import { declareTopology } from '../../../src/events/topology';

const POSTGRES_IMAGE = 'postgres:16-alpine';
const RABBITMQ_IMAGE = 'rabbitmq:4.2-alpine';
const REDIS_IMAGE = 'redis:8-alpine';

export default async function globalSetup() {
  const [container, broker, redis] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
    new RabbitMQContainer(RABBITMQ_IMAGE).start(),
    new GenericContainer(REDIS_IMAGE)
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
  ]);

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

  const connection = await amqp.connect(broker.getAmqpUrl());
  await declareTopology(await connection.createChannel());
  await connection.close();

  process.env.TEST_DATABASE_URL = container.getConnectionUri();
  process.env.DB_URL = `postgres://${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
  process.env.DB_PASSWORD_FILE = secretFile;
  process.env.BROKER_URL = broker.getAmqpUrl();
  process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  process.env.REDIS_QUEUE_URL = process.env.REDIS_URL;
  Object.assign(globalThis, {
    __TEST_DATABASE__: { container, broker, redis, secretDir },
  });
}
