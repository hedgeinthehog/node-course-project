import { DataSource, Repository } from 'typeorm';
import { Task } from '../../src/entities/task.entity';
import { User } from '../../src/entities/user.entity';
import { runWorker } from '../../src/tasks/worker';
import { given } from './testkit/builders';
import { connect, resetDatabase } from './testkit/database';

describe('tasks worker', () => {
  let dataSource: DataSource;
  let tasks: Repository<Task>;

  beforeAll(async () => {
    dataSource = await connect();
    tasks = dataSource.getRepository(Task);
  });
  afterAll(() => dataSource.destroy());
  beforeEach(() => resetDatabase(dataSource));

  const enqueue = (count: number) =>
    tasks.save(
      Array.from({ length: count }, (_, n) =>
        tasks.create({ type: 'email', payload: { n } }),
      ),
    );
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

  it('three concurrent workers process every task exactly once (SKIP LOCKED)', async () => {
    await enqueue(12);

    const results = await Promise.all(
      ['w1', 'w2', 'w3'].map((name) => runWorker(dataSource, name, pause)),
    );

    const handled = results.flatMap((result) => result.done);
    expect(new Set(handled).size).toBe(12);
    expect(handled).toHaveLength(12);
    await expect(
      tasks.countBy({ status: 'done', processed: 1, attempts: 1 }),
    ).resolves.toBe(12);
  });

  it('retries a failing task and completes it on a later attempt', async () => {
    const [task] = await enqueue(1);

    await runWorker(dataSource, 'w1', async (claimed) => {
      if (claimed.attempts === 0) throw new Error('temporary outage');
    });

    await expect(tasks.findOneByOrFail({ id: task.id })).resolves.toMatchObject(
      { status: 'done', processed: 1, attempts: 2, lastError: null },
    );
  });

  it('marks a poison task failed after the attempt limit and rolls back its writes', async () => {
    const buyer = await given(dataSource).user({ name: 'Original' });
    const [task] = await enqueue(1);

    const result = await runWorker(
      dataSource,
      'w1',
      async (_claimed, manager) => {
        await manager.update(User, buyer.id, { name: 'Changed by handler' });
        throw new Error('always broken');
      },
      { maxAttempts: 3 },
    );

    expect(result).toMatchObject({ failed: [task.id], attempts: 3 });
    await expect(tasks.findOneByOrFail({ id: task.id })).resolves.toMatchObject(
      {
        status: 'failed',
        processed: 0,
        attempts: 3,
        lastError: 'always broken',
      },
    );
    await expect(
      dataSource.getRepository(User).findOneByOrFail({ id: buyer.id }),
    ).resolves.toMatchObject({ name: 'Original' });
  });
});
