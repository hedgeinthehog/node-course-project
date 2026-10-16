import { finish, Harness, summary, until } from './events/demo-harness';
import { DEAD_LETTER_QUEUE, ORDER_PLACED_QUEUE } from './events/topology';

async function main() {
  const harness = await Harness.open();

  const order = await harness.placeOrder();
  await harness.publish(order);

  const crashed = harness.spawnConsumer({ CONSUMER_CRASH_AFTER_EFFECT: '1' });
  let exit: { code: number | null; signal: string | null } | undefined;
  crashed.exited.then((result) => (exit = result));
  await until(() => exit !== undefined, 'the first consumer to crash');
  console.log(
    `first consumer: exited with signal ${exit?.signal} after the effect, before ack`,
  );

  const restarted = harness.spawnConsumer();
  await restarted.waitFor(
    (signals) => signals.some((s) => s.stage === 'settled'),
    'the redelivered event to be settled',
  );
  await restarted.stop();

  const signals = [...crashed.signals, ...restarted.signals];
  const count = (predicate: (s: (typeof signals)[number]) => boolean) =>
    signals.filter(predicate).length;
  const deliveries = count((s) => s.stage === 'delivered');
  const redelivered = count((s) => s.stage === 'delivered' && s.redelivered);
  const applied = count((s) => s.stage === 'effect' && s.applied);
  const skipped = count((s) => s.stage === 'effect' && !s.applied);
  const acked = count((s) => s.stage === 'settled' && s.outcome === 'ack');
  const effect = await harness.shipments([order.id]);
  const work = await harness.depth(ORDER_PLACED_QUEUE);
  const dlq = await harness.depth(DEAD_LETTER_QUEUE);
  await harness.close();

  summary({
    published: 1,
    deliveries,
    redelivered,
    applied,
    skipped,
    acked,
    effect,
    work,
    dlq,
  });
  finish(
    exit?.signal === 'SIGKILL' &&
      deliveries >= 2 &&
      redelivered >= 1 &&
      applied === 1 &&
      skipped === deliveries - 1 &&
      acked === 1 &&
      effect === 1 &&
      work === 0 &&
      dlq === 0,
    'the event was delivered twice and the shipment was created once',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
