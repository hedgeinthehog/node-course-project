import { generateKeyPairSync } from 'node:crypto';
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
import { Storage } from '../../../src/files/storage';

const POSTGRES_IMAGE = 'postgres:16-alpine';
const RABBITMQ_IMAGE = 'rabbitmq:4.2-alpine';
const REDIS_IMAGE = 'redis:8-alpine';
const MINIO_IMAGE = 'bitnamilegacy/minio:2025.7.23-debian-12-r5';

export default async function globalSetup() {
  const [container, broker, redis, minio] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
    new RabbitMQContainer(RABBITMQ_IMAGE).start(),
    new GenericContainer(REDIS_IMAGE)
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
    new GenericContainer(MINIO_IMAGE)
      .withEnvironment({
        MINIO_ROOT_USER: 'test',
        MINIO_ROOT_PASSWORD: 'test-secret-1',
      })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
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
  process.env.STORAGE_ENDPOINT = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
  process.env.STORAGE_ACCESS_KEY = 'test';
  process.env.STORAGE_SECRET_KEY = 'test-secret-1';
  process.env.STORAGE_BUCKET = 'test-files';
  await Storage.fromEnv().ensureBucket();
  const b64 = (pem: string) => Buffer.from(pem).toString('base64');
  const keyPair = () =>
    generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
  const keys = keyPair();
  const previous = keyPair();
  process.env.JWT_KID = 'test';
  process.env.JWT_PRIVATE_KEY = b64(keys.privateKey);
  process.env.JWT_PUBLIC_KEYS = `test:${b64(keys.publicKey)},previous:${b64(previous.publicKey)}`;
  process.env.TEST_PREVIOUS_JWT_PRIVATE_KEY = b64(previous.privateKey);
  process.env.REFRESH_TOKEN_PEPPER = 'test-pepper-0123456789abcdef';
  Object.assign(globalThis, {
    __TEST_DATABASE__: { container, broker, redis, minio, secretDir },
  });
}
