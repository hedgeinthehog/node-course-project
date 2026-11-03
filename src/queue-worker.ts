import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { parseRedisUrls } from './config/env.schema';
import { dataSourceOptions } from './data-source';
import { processJob } from './queue/jobs';
import {
  createQueue,
  createWorker,
  ensureSchedulers,
  QUEUE_NAME,
} from './queue/queue';
import { CacheAside } from './redis/cache-aside';

const tag = `worker ${process.pid}`;

async function main() {
  const urls = parseRedisUrls(process.env);
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const cacheRedis = new Redis(urls.cache, { connectionName: 'worker-cache' });
  cacheRedis.on('error', (err) =>
    console.error(`${tag}: cache redis ${err.message}`),
  );
  const cache = new CacheAside(cacheRedis, (message) =>
    console.error(`${tag}: ${message}`),
  );

  const queue = createQueue(urls.queue);
  await ensureSchedulers(queue);
  const worker = createWorker(urls.queue, (job) =>
    processJob(job, {
      dataSource,
      cache,
      log: (message) => console.log(`${tag}: ${message}`),
    }),
  );
  worker.on('completed', (job) =>
    console.log(`${tag}: ${job.name} ${job.id} completed`),
  );
  worker.on('failed', (job, err) =>
    console.error(
      `${tag}: ${job?.name} ${job?.id} failed on attempt ${job?.attemptsMade}: ${err.message}`,
    ),
  );
  worker.on('error', (err) => console.error(`${tag}: ${err.message}`));
  console.log(`${tag}: processing queue ${QUEUE_NAME}`);

  const shutdown = async () => {
    await worker.close();
    await queue.close();
    await cacheRedis.quit();
    await dataSource.destroy();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  if (process.send) process.once('disconnect', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
