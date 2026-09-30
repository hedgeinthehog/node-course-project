import { DataSource } from 'typeorm';
import { checkout, CheckoutError } from './checkout/checkout';
import { dataSourceOptions } from './data-source';

const ATTEMPTS = 50;
const PRODUCT_ID = '1';
const STOCK = 10;

async function main() {
  const dataSource = new DataSource({
    ...dataSourceOptions,
    extra: { max: ATTEMPTS + 5 },
  });
  await dataSource.initialize();

  const [reset]: [{ id: string }[], number] = await dataSource.query(
    `UPDATE products SET stock = $2 WHERE id = $1 RETURNING id`,
    [PRODUCT_ID, STOCK],
  );
  if (reset.length === 0) {
    throw new Error(
      `product ${PRODUCT_ID} not found — run "npm run seed" first`,
    );
  }
  const [{ buyers }] = await dataSource.query(
    `SELECT count(*)::int AS buyers FROM users WHERE id BETWEEN 1 AND 10`,
  );
  if (buyers < 10) {
    throw new Error('seed users 1..10 are missing — run "npm run seed" first');
  }
  const [{ orders_before }] = await dataSource.query(
    `SELECT count(*)::int AS orders_before FROM orders`,
  );

  const started = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: ATTEMPTS }, (_, i) =>
      checkout(dataSource, {
        userId: String((i % 10) + 1),
        items: [{ productId: PRODUCT_ID, quantity: 1 }],
      }),
    ),
  );
  const elapsedMs = Date.now() - started;

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failures = new Map<string, number>();
  for (const r of results) {
    if (r.status === 'rejected') {
      const key =
        r.reason instanceof CheckoutError
          ? r.reason.code
          : `UNEXPECTED: ${(r.reason as Error).message}`;
      failures.set(key, (failures.get(key) ?? 0) + 1);
    }
  }

  const [{ stock }] = await dataSource.query(
    `SELECT stock FROM products WHERE id = $1`,
    [PRODUCT_ID],
  );
  const [{ negative }] = await dataSource.query(
    `SELECT count(*)::int AS negative FROM products WHERE stock < 0`,
  );
  const [{ orders_after }] = await dataSource.query(
    `SELECT count(*)::int AS orders_after FROM orders`,
  );
  await dataSource.destroy();

  const ordersCreated = orders_after - orders_before;
  console.log(`attempts:            ${ATTEMPTS}`);
  console.log(`succeeded:           ${succeeded}`);
  console.log(
    `failed:              ${[...failures].map(([k, v]) => `${k}=${v}`).join(', ') || 0}`,
  );
  console.log(`final stock:         ${stock}`);
  console.log(`rows with stock < 0: ${negative}`);
  console.log(`orders created:      ${ordersCreated}`);
  console.log(`elapsed:             ${elapsedMs} ms`);

  const ok =
    succeeded === STOCK &&
    Number(stock) === 0 &&
    negative === 0 &&
    ordersCreated === succeeded &&
    ![...failures.keys()].some((k) => k.startsWith('UNEXPECTED'));
  console.log(ok ? 'invariant holds: no oversell' : 'INVARIANT VIOLATED');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
