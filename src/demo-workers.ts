import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { runWorker } from './tasks/worker';

const WORKERS = 4;
const TASKS = 40;
const TASK_DURATION_MS = 50;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main() {
  const dataSource = new DataSource({
    ...dataSourceOptions,
    extra: { max: WORKERS + 2 },
  });
  await dataSource.initialize();

  const inserted: { id: string }[] = await dataSource.query(
    `INSERT INTO tasks (type, payload)
     SELECT 'demo_email', jsonb_build_object('n', n) FROM generate_series(1, $1) AS n
     RETURNING id`,
    [TASKS],
  );
  const ids = inserted.map((row) => row.id);

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: WORKERS }, (_, i) =>
      runWorker(dataSource, `worker-${i + 1}`, () => sleep(TASK_DURATION_MS)),
    ),
  );
  const elapsedMs = Date.now() - started;

  const [{ done, twice, distinct_workers }] = await dataSource.query(
    `SELECT count(*) FILTER (WHERE status = 'done')::int AS done,
            count(*) FILTER (WHERE processed > 1)::int AS twice,
            count(DISTINCT worker)::int AS distinct_workers
     FROM tasks WHERE id = ANY($1)`,
    [ids],
  );
  await dataSource.destroy();

  const totalProcessed = results.reduce((sum, r) => sum + r.processed, 0);
  const sequentialMs = totalProcessed * TASK_DURATION_MS;
  console.log(
    `tasks queued:        ${TASKS} (+ any pending left by other demos)`,
  );
  console.log(`workers:             ${WORKERS}`);
  console.log(
    `distribution:        ${results.map((r) => `${r.name}=${r.processed}`).join(', ')}`,
  );
  console.log(`processed total:     ${totalProcessed}`);
  console.log(`оброблено двічі:     ${twice}`);
  console.log(
    `elapsed:             ${elapsedMs} ms (sequential would be ${sequentialMs} ms)`,
  );

  const ok =
    twice === 0 &&
    done === TASKS &&
    distinct_workers >= 2 &&
    elapsedMs < sequentialMs;
  console.log(
    ok ? 'every task processed exactly once' : 'WORKER POOL CHECK FAILED',
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
