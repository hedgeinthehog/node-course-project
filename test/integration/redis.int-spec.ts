import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { processJob } from '../../src/queue/jobs';
import { createQueue, createWorker, JOBS } from '../../src/queue/queue';
import { CacheAside } from '../../src/redis/cache-aside';
import { RateLimiter } from '../../src/redis/rate-limiter';
import { SessionStore } from '../../src/redis/session.store';
import { connect, resetDatabase } from './testkit/database';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('redis: cache, sessions, rate limit, queue', () => {
  let dataSource: DataSource;
  let redis: Redis;
  const url = () => process.env.REDIS_URL!;

  beforeAll(async () => {
    dataSource = await connect();
    redis = new Redis(url());
  });
  afterAll(async () => {
    await redis.quit();
    await dataSource.destroy();
  });
  beforeEach(() => resetDatabase(dataSource));

  it('cache-aside lets exactly one of many concurrent misses hit the loader and jitters the TTL', async () => {
    const cache = new CacheAside(redis);
    let loads = 0;
    const load = async () => {
      loads++;
      await sleep(50);
      return { value: 42 };
    };
    const options = { ttlSec: 300, jitterSec: 60 };

    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        cache.getOrLoad('card:1', load, options),
      ),
    );
    const warm = await cache.getOrLoad('card:1', load, options);

    expect(loads).toBe(1);
    expect(results.every((r) => r?.value === 42)).toBe(true);
    expect(warm).toEqual({ value: 42 });
    expect(await redis.exists(CacheAside.lockKey('card:1'))).toBe(0);
    const ttl = await redis.ttl('card:1');
    expect(ttl).toBeGreaterThanOrEqual(295);
    expect(ttl).toBeLessThanOrEqual(360);
    const ttls = new Set(
      Array.from({ length: 50 }, () => cache.ttlWithJitter(options)),
    );
    expect(ttls.size).toBeGreaterThanOrEqual(5);
  });

  it('cache-aside releases only its own lock and caches a miss with a short negative TTL', async () => {
    const cache = new CacheAside(redis);
    await redis.set(CacheAside.lockKey('card:2'), 'someone-else', 'PX', 60_000);

    expect(await cache.release('card:2', 'my-token')).toBe(false);
    expect(await redis.get(CacheAside.lockKey('card:2'))).toBe('someone-else');
    await redis.del(CacheAside.lockKey('card:2'));

    let loads = 0;
    const missing = async () => {
      loads++;
      await sleep(30);
      return null;
    };
    const options = { ttlSec: 300, jitterSec: 60, negativeTtlSec: 20 };
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        cache.getOrLoad('card:2', missing, options),
      ),
    );
    expect(results.every((r) => r === null)).toBe(true);
    expect(loads).toBe(1);
    expect(await redis.get('card:2')).toBe('null');
    const ttl = await redis.ttl('card:2');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(50);
    expect(await cache.getOrLoad('card:2', missing, options)).toBeNull();
    expect(loads).toBe(1);
  });

  it('sessions live in Redis and every read resets the TTL', async () => {
    const store = new SessionStore(redis, 600);
    const session = await store.create(7);
    await redis.expire(SessionStore.key(session.id), 100);

    const before = await store.ttl(session.id);
    const touched = await store.touch(session.id);
    const after = await store.ttl(session.id);

    expect(before).toBeLessThanOrEqual(100);
    expect(touched).toMatchObject({
      id: session.id,
      userId: 7,
      expiresIn: 600,
    });
    expect(after).toBeGreaterThan(before);
    expect(await store.touch('missing')).toBeNull();
    expect(await store.destroy(session.id)).toBe(true);
    expect(await store.touch(session.id)).toBeNull();
  });

  it('rate limiter is shared between instances and stays exact under concurrency', async () => {
    const options = { limit: 5, windowMs: 10_000 };
    const podA = new RateLimiter(redis, options);
    const podB = new RateLimiter(new Redis(url()), options);

    const sequential = [];
    for (let i = 0; i < 8; i++) {
      sequential.push(await (i % 2 ? podA : podB).hit('client-1'));
    }
    const burst = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        (i % 2 ? podA : podB).hit('client-2'),
      ),
    );

    expect(sequential.filter((v) => v.allowed)).toHaveLength(5);
    expect(sequential.at(-1)).toMatchObject({ allowed: false });
    expect(sequential.at(-1)!.retryAfterMs).toBeGreaterThan(0);
    expect(sequential.at(-1)!.retryAfterMs).toBeLessThanOrEqual(10_000);
    expect(burst.filter((v) => v.allowed)).toHaveLength(5);
    await (podB as unknown as { redis: Redis }).redis.quit();
  });

  it('queue deduplicates by jobId and retries a failing job until it completes', async () => {
    const queue = createQueue(url());
    await queue.obliterate({ force: true });
    await queue.add(JOBS.flaky, { failTimes: 2 }, { jobId: 'flaky-1' });
    await queue.add(JOBS.flaky, { failTimes: 2 }, { jobId: 'flaky-1' });
    expect(
      await queue.getJobCountByTypes('waiting', 'delayed', 'prioritized'),
    ).toBe(1);

    let attempts = 0;
    const worker = createWorker(url(), (job) => {
      attempts++;
      return processJob(job, {
        dataSource,
        cache: new CacheAside(redis),
        log: () => undefined,
      });
    });
    const completed = new Promise<void>((resolve) =>
      worker.on('completed', (job) => job.id === 'flaky-1' && resolve()),
    );
    await completed;
    await worker.close();

    expect(attempts).toBe(3);
    const job = await queue.getJob('flaky-1');
    expect(job?.attemptsMade).toBe(3);
    expect(await job?.getState()).toBe('completed');
    await queue.close();
  });
});
