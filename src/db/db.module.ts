import { readFile } from 'node:fs/promises';
import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { Env } from '../config/env.schema';

export const PG_POOL = 'PG_POOL';

@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const url = new URL(config.get('DB_URL', { infer: true }));
        const passwordFile = config.get('DB_PASSWORD_FILE', { infer: true });
        const pool = new Pool({
          host: url.hostname,
          port: Number(url.port) || 5432,
          user: decodeURIComponent(url.username),
          database: url.pathname.slice(1),
          password: () => readFile(passwordFile, 'utf8').then((s) => s.trim()),
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
