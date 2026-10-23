import { PREFETCH } from './events/consumer';
import { finish, Harness, ownedBy, summary } from './events/demo-harness';
import { orderPlaced } from './events/order-placed';
import { DEAD_LETTER_QUEUE, ORDER_PLACED_QUEUE } from './events/topology';
import type { OrderDto } from './orders/dto/order.dto';

const EVENTS = 5;

async function main() {
  const harness = await Harness.open();

  const orders: OrderDto[] = [];
  for (let i = 0; i < EVENTS; i++) {
    orders.push(await harness.placeOrder());
  }
  const ours = new Set(orders.map((order) => orderPlaced(order).eventId));
  const relayed = (await harness.relay()).published;
  const queued = await harness.depth(ORDER_PLACED_QUEUE);

  const consumer = harness.spawnConsumer();
  await consumer.waitFor(
    (signals) =>
      signals.filter((s) => s.stage === 'settled' && ownedBy(ours)(s)).length >=
      EVENTS,
    `${EVENTS} settled deliveries`,
  );
  await consumer.stop();

  const delivered = consumer.count(
    (s) => s.stage === 'delivered' && ownedBy(ours)(s),
  );
  const acked = consumer.count(
    (s) => s.stage === 'settled' && s.outcome === 'ack' && ownedBy(ours)(s),
  );
  const effect = await harness.shipments(orders.map((order) => order.id));
  const work = await harness.depth(ORDER_PLACED_QUEUE);
  const dlq = await harness.deadLetters();
  const dlqDepth = await harness.depth(DEAD_LETTER_QUEUE);
  await harness.close();

  summary({
    published: EVENTS,
    relayed,
    queued,
    delivered,
    effect,
    acked,
    work,
    dlq,
    'dlq-depth': dlqDepth,
    prefetch: PREFETCH,
  });
  finish(
    effect === EVENTS && acked === EVENTS && work === 0 && dlq === 0,
    'every published event was delivered, applied once and acked',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
