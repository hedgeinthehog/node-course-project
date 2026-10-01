import { DataSource, EntityManager } from 'typeorm';

export interface ClaimedTask {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface WorkerResult {
  name: string;
  done: string[];
  failed: string[];
  attempts: number;
}

export interface WorkerOptions {
  maxAttempts?: number;
}

type TaskStatus = 'pending' | 'done' | 'failed';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runWorker(
  dataSource: DataSource,
  name: string,
  handle: (task: ClaimedTask, manager: EntityManager) => Promise<void>,
  { maxAttempts = 3 }: WorkerOptions = {},
): Promise<WorkerResult> {
  const result: WorkerResult = { name, done: [], failed: [], attempts: 0 };
  for (;;) {
    const outcome = await dataSource.transaction(async (manager) => {
      const rows: ClaimedTask[] = await manager.query(
        `SELECT id, type, payload, attempts FROM tasks
         WHERE status = 'pending'
         ORDER BY id
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      if (rows.length === 0) return null;
      const task = rows[0];
      try {
        await manager.transaction((savepoint) => handle(task, savepoint));
      } catch (err) {
        const [[{ status }]]: [{ status: TaskStatus }[], number] =
          await manager.query(
            `UPDATE tasks
             SET attempts = attempts + 1, worker = $2, last_error = $3,
                 status = CASE WHEN attempts + 1 >= $4 THEN 'failed' ELSE 'pending' END
             WHERE id = $1
             RETURNING status`,
            [
              task.id,
              name,
              String((err as Error).message).slice(0, 500),
              maxAttempts,
            ],
          );
        return { id: task.id, status };
      }
      await manager.query(
        `UPDATE tasks
         SET status = 'done', processed = processed + 1, attempts = attempts + 1,
             worker = $2, processed_at = now(), last_error = NULL
         WHERE id = $1`,
        [task.id, name],
      );
      return { id: task.id, status: 'done' as TaskStatus };
    });
    if (outcome) {
      result.attempts++;
      if (outcome.status === 'done') result.done.push(outcome.id);
      if (outcome.status === 'failed') result.failed.push(outcome.id);
      continue;
    }
    const [{ pending }]: { pending: number }[] = await dataSource.query(
      `SELECT count(*)::int AS pending FROM tasks WHERE status = 'pending'`,
    );
    if (pending === 0) break;
    await sleep(10);
  }
  return result;
}
