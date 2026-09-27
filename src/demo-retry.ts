import { DataSource } from 'typeorm';
import { withRetry } from './common/retry';
import { dataSourceOptions } from './data-source';

const USER_ID = '1';
const WRITERS = 10;
const TOP_UP_CENTS = 100;

async function main() {
  const dataSource = new DataSource({
    ...dataSourceOptions,
    extra: { max: WRITERS + 2 },
  });
  await dataSource.initialize();

  const [{ balance_cents: before }] = await dataSource.query(
    `SELECT balance_cents FROM users WHERE id = $1`,
    [USER_ID],
  );
  if (before === undefined) {
    throw new Error(`user ${USER_ID} not found — run "npm run seed" first`);
  }

  let retries = 0;
  const codes = new Map<string, number>();
  const topUp = (writer: number) =>
    withRetry(
      () =>
        dataSource.transaction('REPEATABLE READ', async (manager) => {
          const [{ balance_cents }] = await manager.query(
            `SELECT balance_cents FROM users WHERE id = $1`,
            [USER_ID],
          );
          await manager.query(`SELECT pg_sleep(0.03)`);
          await manager.query(
            `UPDATE users SET balance_cents = $2 WHERE id = $1`,
            [USER_ID, Number(balance_cents) + TOP_UP_CENTS],
          );
        }),
      {
        maxAttempts: WRITERS + 5,
        baseDelayMs: 5,
        onRetry: (attempt, code, delayMs) => {
          retries++;
          codes.set(code, (codes.get(code) ?? 0) + 1);
          console.log(
            `writer-${writer}: caught ${code}, retrying whole transaction (attempt ${attempt + 1}) in ${delayMs} ms`,
          );
        },
      },
    );

  const started = Date.now();
  await Promise.all(Array.from({ length: WRITERS }, (_, i) => topUp(i + 1)));
  const elapsedMs = Date.now() - started;

  const [{ balance_cents: after }] = await dataSource.query(
    `SELECT balance_cents FROM users WHERE id = $1`,
    [USER_ID],
  );
  await dataSource.destroy();

  const expected = Number(before) + WRITERS * TOP_UP_CENTS;
  console.log(
    `writers:             ${WRITERS} x +${TOP_UP_CENTS} under REPEATABLE READ`,
  );
  console.log(
    `retries:             ${retries} (${[...codes].map(([k, v]) => `${k}=${v}`).join(', ') || 'none'})`,
  );
  console.log(`balance before:      ${before}`);
  console.log(`balance after:       ${after} (expected ${expected})`);
  console.log(`elapsed:             ${elapsedMs} ms`);

  const ok = Number(after) === expected && retries > 0;
  console.log(
    ok ? 'final state is arithmetically correct' : 'RETRY CHECK FAILED',
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
