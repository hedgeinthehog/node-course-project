import { Job, JobsOptions, Queue, Worker, WorkerOptions } from 'bullmq';

export const QUEUE_NAME = 'marketplace';

export const JOBS = {
  confirmation: 'order.confirmation',
  refresh: 'catalog.refresh',
  flaky: 'demo.flaky',
} as const;

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 500, jitter: 0.25 },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 24 * 3600 },
};

export const SCHEDULERS = [
  { id: 'catalog-refresh', every: 60_000, name: JOBS.refresh },
] as const;

export function connectionFor(url: string, role: 'queue' | 'worker') {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: Number(parsed.pathname.slice(1)) || 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    ...(role === 'worker'
      ? { maxRetriesPerRequest: null }
      : {
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          connectTimeout: 1000,
          retryStrategy: (times: number) => Math.min(times * 200, 2000),
        }),
  };
}

export const ENQUEUE_TIMEOUT_MS = 2000;

export async function enqueue(
  queue: Queue,
  name: string,
  data: Record<string, unknown>,
  options: JobsOptions = {},
  timeoutMs = ENQUEUE_TIMEOUT_MS,
): Promise<Job> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      queue.add(name, data, options),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `queue.add ${name} timed out after ${timeoutMs} ms, is Redis up?`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createQueue(url: string): Queue {
  return new Queue(QUEUE_NAME, {
    connection: connectionFor(url, 'queue'),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
}

export function createWorker(
  url: string,
  processor: (job: Job) => Promise<unknown>,
  options: Omit<WorkerOptions, 'connection'> = {},
): Worker {
  return new Worker(QUEUE_NAME, processor, {
    connection: connectionFor(url, 'worker'),
    concurrency: 5,
    ...options,
  });
}

export async function ensureSchedulers(queue: Queue, every?: number) {
  for (const scheduler of SCHEDULERS) {
    await queue.upsertJobScheduler(
      scheduler.id,
      { every: every ?? scheduler.every },
      { name: scheduler.name },
    );
  }
}
