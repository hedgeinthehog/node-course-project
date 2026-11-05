import Redis from 'ioredis';
import { parseRedisUrls } from './config/env.schema';
import { finish, sleep, summary, until } from './events/demo-harness';
import { processJob } from './queue/jobs';
import { createQueue, createWorker, JOBS } from './queue/queue';
import { CacheAside } from './redis/cache-aside';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';

const FAIL_TIMES = 2;
const TICK_MS = 1000;
const OBSERVE_MS = 3500;

async function main() {
  const urls = parseRedisUrls(process.env);
  const redis = new Redis(urls.queue);
  const [, policy] = (await redis.config(
    'GET',
    'maxmemory-policy',
  )) as string[];
  const queue = createQueue(urls.queue);
  const workers = await queue.getWorkers();
  if (workers.length > 0) {
    throw new Error(
      `${workers.length} worker(s) are attached to the queue; stop "npm run worker" before running the demo`,
    );
  }
  await queue.obliterate({ force: true });

  const jobId = 'demo-flaky';
  await queue.add(JOBS.flaky, { failTimes: FAIL_TIMES }, { jobId });
  await queue.add(JOBS.flaky, { failTimes: FAIL_TIMES }, { jobId });
  const added = 2;
  const queued = await queue.getJobCountByTypes(
    'waiting',
    'delayed',
    'prioritized',
    'active',
  );

  await queue.upsertJobScheduler(
    'demo-tick',
    { every: TICK_MS },
    { name: JOBS.flaky, data: { failTimes: 0 } },
  );
  await queue.upsertJobScheduler(
    'demo-tick',
    { every: TICK_MS },
    { name: JOBS.flaky, data: { failTimes: 0 } },
  );
  const schedulers = (await queue.getJobSchedulers()).length;

  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const cache = new CacheAside(new Redis(urls.cache));
  let attempts = 0;
  let scheduledRuns = 0;
  const worker = createWorker(urls.queue, async (job) => {
    if (job.id === jobId) attempts++;
    else if (job.repeatJobKey) scheduledRuns++;
    return processJob(job, {
      dataSource,
      cache,
      log: (m) => console.log(`worker: ${m}`),
    });
  });
  worker.on('failed', (job, err) =>
    console.log(
      `worker: ${job?.id} failed on attempt ${job?.attemptsMade}: ${err.message}`,
    ),
  );
  let completed = 0;
  worker.on('completed', (job) => {
    if (job.id === jobId) completed++;
  });

  const started = Date.now();
  await until(
    () => completed === 1,
    'the flaky job to complete after its retries',
    30_000,
  );
  const flakyMs = Date.now() - started;
  await sleep(Math.max(0, OBSERVE_MS - flakyMs));
  await worker.close();
  await queue.removeJobScheduler('demo-tick');
  await queue.close();
  await dataSource.destroy();
  await redis.quit();

  summary({
    'queue-noeviction': policy === 'noeviction' ? 1 : 0,
    'fail-times': FAIL_TIMES,
    attempts,
    completed,
    added,
    queued,
    schedulers,
    'observe-ms': OBSERVE_MS,
    'scheduled-runs': scheduledRuns,
  });
  finish(
    policy === 'noeviction' &&
      attempts === FAIL_TIMES + 1 &&
      completed === 1 &&
      queued === 1 &&
      schedulers >= 1 &&
      scheduledRuns >= 2,
    'the queue retried with backoff, deduplicated by jobId and ran the scheduler',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
