import { finish, Harness, summary, until } from './events/demo-harness';
import { orderPlaced } from './events/order-placed';
import {
  DEAD_LETTER_QUEUE,
  DELIVERY_LIMIT,
  ORDER_PLACED_QUEUE,
} from './events/topology';

const DEATH_REASONS = ['rejected', 'expired', 'maxlen', 'delivery_limit'];

async function main() {
  const harness = await Harness.open();

  const [{ missing }]: { missing: number }[] = await harness.dataSource.query(
    `SELECT coalesce(max(id), 0)::int + 1000000 AS missing FROM orders`,
  );
  await harness.publisher.publish(
    orderPlaced({
      id: missing,
      user_id: 1,
      items: [{ product_id: 1, quantity: 1 }],
      total_cents: 2500,
      status: 'paid',
      created_at: new Date().toISOString(),
    }),
  );

  const consumer = harness.spawnConsumer();
  await until(
    async () => (await harness.depth(DEAD_LETTER_QUEUE)) === 1,
    'the poison message to reach the dead-letter queue',
  );
  await consumer.stop();

  const dead = await harness.channel.get(DEAD_LETTER_QUEUE, { noAck: false });
  if (!dead) throw new Error('dead-letter queue is empty');
  const headers = dead.properties.headers ?? {};
  const reason = String(headers['x-first-death-reason']);
  console.log(`x-death: ${JSON.stringify(headers['x-death'])}`);
  harness.channel.nack(dead, false, true);
  await until(
    async () => (await harness.depth(DEAD_LETTER_QUEUE)) === 1,
    'the peeked message to return to the dead-letter queue',
  );

  const deliveries = consumer.count((s) => s.stage === 'delivered');
  const rejected = consumer.count(
    (s) => s.stage === 'settled' && s.outcome === 'requeue',
  );
  const effect = await harness.shipments([missing]);
  const work = await harness.depth(ORDER_PLACED_QUEUE);
  const dlq = await harness.depth(DEAD_LETTER_QUEUE);
  await harness.close();

  summary({
    published: 1,
    deliveries,
    rejected,
    'delivery-limit': DELIVERY_LIMIT,
    work,
    dlq,
    'dlq-reason': reason,
    effect,
  });
  finish(
    work === 0 &&
      dlq === 1 &&
      DEATH_REASONS.includes(reason) &&
      effect === 0 &&
      deliveries === DELIVERY_LIMIT + 1 &&
      rejected === deliveries,
    'the poison message left the work queue for the DLQ with a readable reason',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
