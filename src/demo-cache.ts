import Redis from 'ioredis';
import { parseRedisUrls } from './config/env.schema';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { finish, newProducts, summary } from './events/demo-harness';
import {
  loadProductCard,
  PRODUCT_CARD_TTL,
  productCardKey,
} from './products/product-card';
import { CacheAside } from './redis/cache-aside';

const WARM = 60;
const CONCURRENT = 25;
const WARM_READS = 100;

async function main() {
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const redis = new Redis(parseRedisUrls(process.env).cache);
  const [, policy] = (await redis.config(
    'GET',
    'maxmemory-policy',
  )) as string[];
  const [, maxmemory] = (await redis.config('GET', 'maxmemory')) as string[];
  await redis.flushdb();
  const cache = new CacheAside(redis);

  let dbCalls = 0;
  const card = (id: number) =>
    cache.getOrLoad(
      productCardKey(id),
      () => {
        dbCalls++;
        return loadProductCard(dataSource, String(id));
      },
      PRODUCT_CARD_TTL,
    );

  const ids = await newProducts(dataSource, WARM);
  for (const id of ids) await card(id);
  const ttls = await Promise.all(
    ids.map((id) => redis.ttl(productCardKey(id))),
  );
  const warmed = ttls.filter((ttl) => ttl > 0).length;
  const ttlDistinct = new Set(ttls).size;

  const target = ids[0];
  await cache.invalidate(productCardKey(target));
  dbCalls = 0;
  const results = await Promise.all(
    Array.from({ length: CONCURRENT }, () => card(target)),
  );
  const dbCallsStampede = dbCalls;
  const identical = results.every(
    (result) => JSON.stringify(result) === JSON.stringify(results[0]),
  );

  dbCalls = 0;
  for (let i = 0; i < WARM_READS; i++) await card(ids[i % ids.length]);
  const dbCallsWarm = dbCalls;
  const lockLeft = await redis.exists(
    CacheAside.lockKey(productCardKey(target)),
  );

  await redis.quit();
  await dataSource.destroy();

  summary({
    'cache-lru': policy !== 'noeviction' ? 1 : 0,
    'cache-maxmemory': Number(maxmemory) > 0 ? 1 : 0,
    warmed,
    'ttl-min': Math.min(...ttls),
    'ttl-max': Math.max(...ttls),
    'ttl-distinct': ttlDistinct,
    concurrent: CONCURRENT,
    'db-calls': dbCallsStampede,
    'identical-results': identical ? 1 : 0,
    'lock-left': lockLeft,
    'warm-reads': WARM_READS,
    'db-calls-warm': dbCallsWarm,
  });
  finish(
    policy !== 'noeviction' &&
      Number(maxmemory) > 0 &&
      warmed >= 50 &&
      ttlDistinct >= 5 &&
      dbCallsStampede === 1 &&
      identical &&
      lockLeft === 0 &&
      dbCallsWarm === 0,
    'the cache absorbed the stampede with one database read and served the warm reads without any',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
