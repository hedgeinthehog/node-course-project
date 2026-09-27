import { readFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Client, ClientConfig } from 'pg';
import { Env } from '../config/env.schema';
import { entities } from '../entities';

function readCredentials(file: string) {
  const content = readFileSync(file, 'utf8').trim();
  const separator = content.indexOf(':');
  const user = content.slice(0, Math.max(separator, 0));
  const password = content.slice(separator + 1);
  if (!user || !password) {
    throw new Error(`${file} must contain "user:password"`);
  }
  return { user, password };
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const url = new URL(config.get('DB_URL', { infer: true }));
        const passwordFile = config.get('DB_PASSWORD_FILE', { infer: true });

        class SecretFileClient extends Client {
          constructor(options: ClientConfig) {
            super({ ...options, ...readCredentials(passwordFile) });
          }
        }

        return {
          type: 'postgres',
          host: url.hostname,
          port: Number(url.port) || 5432,
          database: url.pathname.slice(1),
          entities,
          synchronize: false,
          extra: { Client: SecretFileClient },
        };
      },
    }),
  ],
})
export class DbModule {}
