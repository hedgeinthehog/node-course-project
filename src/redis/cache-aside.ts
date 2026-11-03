import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

export interface CacheAsideOptions {
  ttlSec: number;
  jitterSec: number;
  lockMs?: number;
}

const RELEASE_IF_OWNED = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

const WAIT_STEP_MS = 20;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class CacheAside {
  constructor(
    private readonly redis: Redis,
    private readonly onError: (message: string) => void = console.error,
  ) {}

  static lockKey(key: string) {
    return `lock:${key}`;
  }

  ttlWithJitter({ ttlSec, jitterSec }: CacheAsideOptions): number {
    return ttlSec + Math.floor(Math.random() * (jitterSec + 1));
  }

  async getOrLoad<T>(
    key: string,
    load: () => Promise<T | null>,
    options: CacheAsideOptions,
  ): Promise<T | null> {
    const cached = await this.read<T>(key);
    if (cached !== undefined) return cached;
    const lockKey = CacheAside.lockKey(key);
    const lockMs = options.lockMs ?? 3000;
    for (;;) {
      const token = randomUUID();
      let locked: 'OK' | null;
      try {
        locked = await this.redis.set(lockKey, token, 'PX', lockMs, 'NX');
      } catch (err) {
        this.onError(`cache lock ${key}: ${(err as Error).message}`);
        return load();
      }
      if (locked === 'OK') {
        try {
          const value = await load();
          if (value !== null) await this.write(key, value, options);
          return value;
        } finally {
          await this.release(key, token);
        }
      }
      const deadline = Date.now() + lockMs;
      while (Date.now() < deadline) {
        await sleep(WAIT_STEP_MS);
        const refreshed = await this.read<T>(key);
        if (refreshed !== undefined) return refreshed;
        if (!(await this.redis.exists(lockKey))) break;
      }
    }
  }

  async release(key: string, token: string): Promise<boolean> {
    try {
      const removed = await this.redis.eval(
        RELEASE_IF_OWNED,
        1,
        CacheAside.lockKey(key),
        token,
      );
      return removed === 1;
    } catch (err) {
      this.onError(`cache unlock ${key}: ${(err as Error).message}`);
      return false;
    }
  }

  async invalidate(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.redis.del(...keys);
    } catch (err) {
      this.onError(`cache invalidate: ${(err as Error).message}`);
    }
  }

  private async read<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.redis.get(key);
      return raw === null ? undefined : (JSON.parse(raw) as T);
    } catch (err) {
      this.onError(`cache read ${key}: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async write(
    key: string,
    value: unknown,
    options: CacheAsideOptions,
  ): Promise<void> {
    try {
      await this.redis.set(
        key,
        JSON.stringify(value),
        'EX',
        this.ttlWithJitter(options),
      );
    } catch (err) {
      this.onError(`cache write ${key}: ${(err as Error).message}`);
    }
  }
}
