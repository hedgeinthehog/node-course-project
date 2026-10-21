import { finish, Harness, summary, until } from './events/demo-harness';
import { orderPlaced } from './events/order-placed';
import {
  DEAD_LETTER_QUEUE,
  ORDER_PLACED_QUEUE,
  RETRY_DELAY_MS,
  RETRY_QUEUE,
} from './events/topology';

const DEATH_REASONS = ['rejected', 'expired', 'maxlen', 'delivery_limit'];

async function main() {
  const harness = await Harness.open();

  const [{ missing }]: { missing: number }[] = await harness.dataSource.query(
    `SELECT coalesce(max(id), 0)::int + 1000000 + floor(random() * 1000000)::int AS missing FROM orders`,
  );
  const poison = orderPlaced({
    id: missing,
    user_id: 1,
    items: [{ product_id: 1, quantity: 1 }],
    total_cents: 2500,
    status: 'paid',
    created_at: new Date().toISOString(),
  });
  await harness.publisher.publish(poison);

  const consumer = harness.spawnConsumer();
  await until(
    async () => (await harness.deadLetters()) === 1,
    'the poison message to reach the dead-letter queue',
    60_000,
  );
  await consumer.stop();

  const dead = (await harness.peekDeadLetters()).find(
    (msg) => msg.properties.messageId === poison.eventId,
  );
  if (!dead)
    throw new Error('the poison message is not in the dead-letter queue');
  const headers = dead.properties.headers ?? {};
  const deaths = headers['x-death'] ?? [];
  const death =
    deaths.find((entry) => entry.queue === ORDER_PLACED_QUEUE) ?? deaths[0];
  const reason = String(death?.reason ?? headers['x-first-death-reason']);
  console.log(`x-death: ${JSON.stringify(deaths)}`);

  const deliveries = consumer.count((s) => s.stage === 'delivered');
  const retries = consumer.count(
    (s) => s.stage === 'settled' && s.outcome === 'retry',
  );
  const rejected = consumer.count(
    (s) => s.stage === 'settled' && s.outcome === 'drop',
  );
  const effect = await harness.shipments([missing]);
  const work = await harness.depth(ORDER_PLACED_QUEUE);
  const retry = await harness.depth(RETRY_QUEUE);
  const dlq = await harness.deadLetters();
  const dlqDepth = await harness.depth(DEAD_LETTER_QUEUE);
  await harness.close();

  summary({
    published: 1,
    deliveries,
    retries,
    'retry-delay-ms': RETRY_DELAY_MS,
    rejected,
    work,
    retry,
    dlq,
    'dlq-depth': dlqDepth,
    'dlq-reason': reason,
    effect,
  });
  finish(
    work === 0 && dlq === 1 && DEATH_REASONS.includes(reason) && effect === 0,
    'the poison message left the work queue for the DLQ with a readable reason',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
