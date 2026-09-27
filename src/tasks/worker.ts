import { DataSource } from 'typeorm';

export interface ClaimedTask {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface WorkerResult {
  name: string;
  processed: number;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runWorker(
  dataSource: DataSource,
  name: string,
  handle: (task: ClaimedTask) => Promise<void>,
): Promise<WorkerResult> {
  let processed = 0;
  for (;;) {
    const claimed = await dataSource.transaction(async (manager) => {
      const rows: ClaimedTask[] = await manager.query(
        `SELECT id, type, payload FROM tasks
         WHERE status = 'pending'
         ORDER BY id
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      if (rows.length === 0) return false;
      await handle(rows[0]);
      await manager.query(
        `UPDATE tasks
         SET status = 'done', processed = processed + 1, worker = $2, processed_at = now()
         WHERE id = $1`,
        [rows[0].id, name],
      );
      return true;
    });
    if (claimed) {
      processed++;
      continue;
    }
    const [{ pending }]: { pending: number }[] = await dataSource.query(
      `SELECT count(*)::int AS pending FROM tasks WHERE status = 'pending'`,
    );
    if (pending === 0) break;
    await sleep(10);
  }
  return { name, processed };
}
