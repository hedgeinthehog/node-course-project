import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { ClaimedTask, runWorker } from './tasks/worker';

const WORKERS = 4;
const OK_TASKS = 40;
const FLAKY_TASKS = 1;
const POISON_TASKS = 2;
const MAX_ATTEMPTS = 3;
const TASK_DURATION_MS = 50;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function handle(task: ClaimedTask) {
  await sleep(TASK_DURATION_MS);
  const failTimes = Number(task.payload.fail_times ?? 0);
  if (task.attempts < failTimes) {
    throw new Error(`simulated failure on attempt ${task.attempts + 1}`);
  }
}

async function main() {
  const dataSource = new DataSource({
    ...dataSourceOptions,
    extra: { max: WORKERS + 2 },
  });
  await dataSource.initialize();

  const [{ leftover }]: { leftover: number }[] = await dataSource.query(
    `SELECT count(*)::int AS leftover FROM tasks WHERE status = 'pending'`,
  );
  const inserted: { id: string; type: string }[] = await dataSource.query(
    `INSERT INTO tasks (type, payload)
     SELECT 'demo_email', jsonb_build_object('n', n) FROM generate_series(1, $1) AS n
     UNION ALL
     SELECT 'demo_flaky', jsonb_build_object('fail_times', 1) FROM generate_series(1, $2)
     UNION ALL
     SELECT 'demo_poison', jsonb_build_object('fail_times', $4::int) FROM generate_series(1, $3)
     RETURNING id, type`,
    [OK_TASKS, FLAKY_TASKS, POISON_TASKS, MAX_ATTEMPTS + 1],
  );
  const own = (type: string) =>
    inserted.filter((row) => row.type === type).map((row) => row.id);

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: WORKERS }, (_, i) =>
      runWorker(dataSource, `worker-${i + 1}`, handle, {
        maxAttempts: MAX_ATTEMPTS,
      }),
    ),
  );
  const elapsedMs = Date.now() - started;

  const doneIds = results.flatMap((r) => r.done);
  const failedIds = results.flatMap((r) => r.failed);
  const touched = [...doneIds, ...failedIds];
  const attempts = results.reduce((sum, r) => sum + r.attempts, 0);

  const [state]: {
    total: number;
    done: number;
    failed: number;
    pending: number;
    twice: number;
    over_limit: number;
    distinct_workers: number;
  }[] = await dataSource.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'done' AND processed = 1)::int AS done,
            count(*) FILTER (WHERE status = 'failed' AND processed = 0 AND attempts = $2)::int AS failed,
            count(*) FILTER (WHERE status = 'pending')::int AS pending,
            count(*) FILTER (WHERE processed > 1)::int AS twice,
            count(*) FILTER (WHERE attempts > $2)::int AS over_limit,
            count(DISTINCT worker)::int AS distinct_workers
     FROM tasks WHERE id = ANY($1)`,
    [touched, MAX_ATTEMPTS],
  );
  const [{ flaky_attempts }]: { flaky_attempts: number | null }[] =
    await dataSource.query(
      `SELECT min(attempts)::int AS flaky_attempts FROM tasks WHERE id = ANY($1)`,
      [own('demo_flaky')],
    );
  await dataSource.destroy();

  const sequentialMs = attempts * TASK_DURATION_MS;
  const expectedDone = [...own('demo_email'), ...own('demo_flaky')];
  console.log(
    `tasks queued:        ${inserted.length} (${OK_TASKS} ok, ${FLAKY_TASKS} flaky, ${POISON_TASKS} poison) + ${leftover} pending left by other demos`,
  );
  console.log(`workers:             ${WORKERS}`);
  console.log(
    `distribution:        ${results.map((r) => `${r.name}=${r.done.length}`).join(', ')}`,
  );
  console.log(`tasks touched:       ${touched.length}`);
  console.log(`done:                ${doneIds.length}`);
  console.log(
    `failed:              ${failedIds.length} (status = failed after ${MAX_ATTEMPTS} attempts)`,
  );
  console.log(
    `attempts:            ${attempts} (${attempts - touched.length} retries)`,
  );
  console.log(`оброблено двічі: ${state.twice}`);
  console.log(
    `elapsed:             ${elapsedMs} ms (sequential would be ${sequentialMs} ms = ${attempts} attempts x ${TASK_DURATION_MS} ms)`,
  );

  const ok =
    new Set(touched).size === touched.length &&
    state.total === touched.length &&
    state.done === doneIds.length &&
    state.failed === failedIds.length &&
    state.pending === 0 &&
    state.twice === 0 &&
    state.over_limit === 0 &&
    state.distinct_workers >= 2 &&
    touched.length === leftover + inserted.length &&
    expectedDone.every((id) => doneIds.includes(id)) &&
    own('demo_poison').every((id) => failedIds.includes(id)) &&
    failedIds.length === POISON_TASKS &&
    flaky_attempts === 2 &&
    elapsedMs < sequentialMs;
  console.log(
    ok
      ? 'every touched task is done exactly once or failed after the attempt limit'
      : 'WORKER POOL CHECK FAILED',
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
