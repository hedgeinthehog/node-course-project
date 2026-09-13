import { readFileSync } from 'node:fs';
import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, Pool, PoolConfig } from 'pg';
import { Env } from '../config/env.schema';

export const PG_POOL = 'PG_POOL';

function readCredentials(file: string) {
  const [user, password] = readFileSync(file, 'utf8').trim().split(':');
  if (!user || !password) {
    throw new Error(`${file} must contain "user:password"`);
  }
  return { user, password };
}

@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const url = new URL(config.get('DB_URL', { infer: true }));
        const passwordFile = config.get('DB_PASSWORD_FILE', { infer: true });

        class SecretFileClient extends Client {
          constructor(options: PoolConfig) {
            super({ ...options, ...readCredentials(passwordFile) });
          }
        }

        const pool = new Pool({
          host: url.hostname,
          port: Number(url.port) || 5432,
          database: url.pathname.slice(1),
          Client: SecretFileClient as unknown as PoolConfig['Client'],
        });
        pool.on('error', (err) => {
          new Logger('PgPool').warn(`idle client error: ${err.message}`);
        });
        return pool;
      },
    },
  ],
  exports: [PG_POOL],
})
export class DbModule {}
