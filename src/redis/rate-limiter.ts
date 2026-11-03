import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

const SLIDING_WINDOW = `
local key, now, window, limit, member = KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, 0}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {0, 0, tonumber(oldest[2]) + window - now}`;

export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    readonly options: RateLimitOptions,
  ) {}

  static key(client: string) {
    return `ratelimit:${client}`;
  }

  async hit(client: string, now = Date.now()): Promise<RateLimitVerdict> {
    const [allowed, remaining, retryAfterMs] = (await this.redis.eval(
      SLIDING_WINDOW,
      1,
      RateLimiter.key(client),
      now,
      this.options.windowMs,
      this.options.limit,
      `${now}:${randomUUID()}`,
    )) as [number, number, number];
    return { allowed: allowed === 1, remaining, retryAfterMs };
  }
}
