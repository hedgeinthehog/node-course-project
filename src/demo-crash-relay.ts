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
  const { result: order } = await placeOrder(
    harness.dataSource,
    `demo-crash-relay-${randomUUID()}`,
    dto,
  );
  const ours = new Set([orderPlaced(order).eventId]);

  const consumer = harness.spawnConsumer();
  const crashed = harness.spawnRelay({ RELAY_CRASH_AFTER_PUBLISH: '1' });
  let exit: { code: number | null; signal: string | null } | undefined;
  crashed.exited.then((result) => (exit = result));
  await until(() => exit !== undefined, 'the first relay to crash');
  console.log(
    `first relay: exited with signal ${exit?.signal} after publish, before UPDATE published_at`,
  );
  const publishedAfterCrash = (await harness.outboxOf(buyerId)).published;

  const relay = harness.spawnRelay();
  await until(
    async () => (await harness.outboxOf(buyerId)).published === 1,
    'the second relay to publish the row again',
  );
  await consumer.waitFor(
    (signals) =>
      signals.filter((s) => s.stage === 'settled' && ownedBy(ours)(s)).length >=
      2,
    'the consumer to settle both deliveries',
  );
  await relay.stop();
  await consumer.stop();

  const owned = consumer.signals.filter(ownedBy(ours));
  const count = (predicate: (s: (typeof owned)[number]) => boolean) =>
    owned.filter(predicate).length;
  const deliveries = count((s) => s.stage === 'delivered');
  const applied = count((s) => s.stage === 'effect' && s.applied);
  const skipped = count((s) => s.stage === 'effect' && !s.applied);
  const outbox = await harness.outboxOf(buyerId);
  const effect = await harness.shipments([order.id]);
  const processed = await harness.processed([...ours]);
  const work = await harness.depth(ORDER_PLACED_QUEUE);
  const dlq = await harness.deadLetters();
  const dlqDepth = await harness.depth(DEAD_LETTER_QUEUE);
  await harness.close();

  summary({
    outbox: outbox.total,
    'published-after-crash': publishedAfterCrash,
    published: outbox.published,
    'relay-runs': 2,
    deliveries,
    applied,
    skipped,
    effect,
    processed,
    work,
    dlq,
    'dlq-depth': dlqDepth,
  });
  finish(
    exit?.signal === 'SIGKILL' &&
      publishedAfterCrash === 0 &&
      deliveries >= 2 &&
      applied === 1 &&
      effect === 1 &&
      processed === 1,
    'the event was published twice after the relay crash and applied exactly once',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
