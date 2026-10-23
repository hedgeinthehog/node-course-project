import { checkout } from './checkout/checkout';
import { finish, Harness, sleep, summary } from './events/demo-harness';
import { ORDER_PLACED_QUEUE } from './events/topology';

const QUIET_MS = 1500;

async function main() {
  const harness = await Harness.open();
  const { buyerId, dto } = await harness.newBuyer();

  let outboxInTransaction = 0;
  let writeFailed = 0;
  try {
    await harness.dataSource.transaction(async (manager) => {
      await checkout(manager, {
        userId: String(dto.user_id),
        items: dto.items.map((item) => ({
          productId: String(item.product_id),
          quantity: item.quantity,
        })),
      });
      const [{ rows }]: { rows: number }[] = await manager.query(
        `SELECT count(*)::int AS rows FROM outbox
         WHERE (payload -> 'payload' ->> 'userId')::bigint = $1`,
        [buyerId],
      );
      outboxInTransaction = rows;
      throw new Error('simulated crash after the outbox insert, before COMMIT');
    });
  } catch (err) {
    console.log(`business write failed: ${(err as Error).message}`);
    writeFailed = 1;
  }

  const orders = await harness.ordersOf(buyerId);
  const outbox = await harness.outboxOf(buyerId);

  const relay = harness.spawnRelay();
  await relay.waitFor(
    (signals) => signals.filter((s) => s.stage === 'polled').length >= 2,
    'the relay to poll the outbox twice',
  );
  await relay.stop();
  const published = (await harness.outboxOf(buyerId)).published;

  const consumer = harness.spawnConsumer();
  await sleep(QUIET_MS);
  await consumer.stop();
  const deliveries = consumer.count((s) => s.stage === 'delivered');
  const effect = await harness.shipmentsOf(buyerId);
  const work = await harness.depth(ORDER_PLACED_QUEUE);
  await harness.close();

  summary({
    'write-failed': writeFailed,
    'outbox-in-transaction': outboxInTransaction,
    orders,
    outbox: outbox.total,
    published,
    deliveries,
    effect,
    work,
  });
  finish(
    writeFailed === 1 &&
      outboxInTransaction === 1 &&
      orders === 0 &&
      outbox.total === 0 &&
      published === 0 &&
      deliveries === 0 &&
      effect === 0,
    'the failed business write took its outbox row down with it, nothing left the database',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
