import { Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import Redis from 'ioredis';
import { Env } from '../config/env.schema';
import { CacheAside } from './cache-aside';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimiter } from './rate-limiter';
import { SessionStore } from './session.store';

export const REDIS_CACHE = 'REDIS_CACHE';
export const REDIS_STATE = 'REDIS_STATE';

class RedisConnections implements OnModuleDestroy {
  constructor(private readonly clients: Redis[]) {}

  onModuleDestroy() {
    return Promise.all(this.clients.map((client) => client.quit()));
  }
}

const client = (url: string, name: string) => {
  const redis = new Redis(url, { connectionName: name, lazyConnect: false });
  redis.on('error', (err) => new Logger(`Redis:${name}`).error(err.message));
  return redis;
};

@Module({
  providers: [
    {
      provide: REDIS_CACHE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        client(config.get('REDIS_URL', { infer: true }), 'cache'),
    },
    {
      provide: REDIS_STATE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        client(config.get('REDIS_QUEUE_URL', { infer: true }), 'state'),
    },
    {
      provide: RedisConnections,
      inject: [REDIS_CACHE, REDIS_STATE],
      useFactory: (cache: Redis, state: Redis) =>
        new RedisConnections([cache, state]),
    },
    {
      provide: CacheAside,
      inject: [REDIS_CACHE],
      useFactory: (cache: Redis) =>
        new CacheAside(cache, (message) =>
          new Logger(CacheAside.name).error(message),
        ),
    },
    {
      provide: SessionStore,
      inject: [REDIS_STATE],
      useFactory: (state: Redis) => new SessionStore(state),
    },
    {
      provide: RateLimiter,
      inject: [REDIS_STATE, ConfigService],
      useFactory: (state: Redis, config: ConfigService<Env, true>) =>
        new RateLimiter(state, {
          limit: config.get('RATE_LIMIT', { infer: true }),
          windowMs: config.get('RATE_LIMIT_WINDOW_MS', { infer: true }),
        }),
    },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  exports: [REDIS_CACHE, REDIS_STATE, CacheAside, SessionStore, RateLimiter],
})
export class RedisModule {}
