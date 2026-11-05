import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import amqp from 'amqplib';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { appOptions, configureApp } from '../app.setup';
import { parseDbEnv } from '../config/db-env.schema';
import { parseBrokerUrl } from '../config/env.schema';
import { declareTopology } from '../events/topology';

export interface RunningApi {
  url: string;
  close(): Promise<void>;
}

export async function bootApi(
  env: Record<string, string> = {},
): Promise<RunningApi> {
  Object.assign(process.env, env);
  if (!process.env.DB_URL || !process.env.DB_PASSWORD_FILE) {
    const db = parseDbEnv(process.env);
    process.env.DB_URL ??= `postgres://${db.DB_HOST}:${db.DB_PORT}/${db.DB_NAME}`;
    if (!process.env.DB_PASSWORD_FILE) {
      const file = join(
        mkdtempSync(join(tmpdir(), 'demo-api-')),
        'db_password',
      );
      writeFileSync(file, `${db.DB_USER}:${db.DB_PASSWORD}`, { mode: 0o600 });
      process.env.DB_PASSWORD_FILE = file;
    }
  }
  const broker = await amqp.connect(parseBrokerUrl(process.env));
  await declareTopology(await broker.createChannel());
  await broker.close();
  const { AppModule } = await import('../app.module.js');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    ...appOptions,
    logger: ['error', 'warn'],
  });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => app.close() };
}
