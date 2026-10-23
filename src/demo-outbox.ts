import { randomUUID } from 'node:crypto';
import {
  finish,
  Harness,
  ownedBy,
  summary,
  until,
} from './events/demo-harness';
import { orderPlaced } from './events/order-placed';
import { DEAD_LETTER_QUEUE, ORDER_PLACED_QUEUE } from './events/topology';
import { placeOrder } from './orders/place-order';

async function main() {
  const harness = await Harness.open();
  const { buyerId, dto } = await harness.newBuyer();
  const key = `demo-outbox-${randomUUID()}`;

  const first = await placeOrder(harness.dataSource, key, dto);
  const second = await placeOrder(harness.dataSource, key, dto);
  const ours = new Set([orderPlaced(first.result).eventId]);

  const consumer = harness.spawnConsumer();
  const relay = harness.spawnRelay();
  await until(
    async () => (await harness.outboxOf(buyerId)).published === 1,
    'the relay to publish the outbox row',
  );
  await consumer.waitFor(
    (signals) => signals.some((s) => s.stage === 'settled' && ownedBy(ours)(s)),
    'the consumer to settle the event',
  );
  await relay.stop();
  await consumer.stop();

  const orders = await harness.ordersOf(buyerId);
  const outbox = await harness.outboxOf(buyerId);
  const deliveries = consumer.count(
    (s) => s.stage === 'delivered' && ownedBy(ours)(s),
  );
  const effect = await harness.shipments([first.result.id]);
  const processed = await harness.processed([...ours]);
  const work = await harness.depth(ORDER_PLACED_QUEUE);
  const dlq = await harness.deadLetters();
  const dlqDepth = await harness.depth(DEAD_LETTER_QUEUE);
  await harness.close();

  summary({
    requests: 2,
    replayed: second.replayed ? 1 : 0,
    'same-order': second.result.id === first.result.id ? 1 : 0,
    orders,
    outbox: outbox.total,
    published: outbox.published,
    deliveries,
    effect,
    processed,
    work,
    dlq,
    'dlq-depth': dlqDepth,
  });
  finish(
    orders === 1 &&
      outbox.total === 1 &&
      outbox.published === 1 &&
      effect === 1 &&
      processed === 1,
    'two requests with one Idempotency-Key gave one order, one outbox row, one event and one effect',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
