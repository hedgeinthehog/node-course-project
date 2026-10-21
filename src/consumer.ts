import amqp from 'amqplib';
import { DataSource } from 'typeorm';
import { parseBrokerUrl } from './config/env.schema';
import { dataSourceOptions } from './data-source';
import { ConsumerSignal, PREFETCH, startConsumer } from './events/consumer';
import { ORDER_PLACED_QUEUE, RETRY_DELAY_MS } from './events/topology';

const tag = `consumer ${process.pid}`;
const crashAfterEffect = process.env.CONSUMER_CRASH_AFTER_EFFECT === '1';

function describe(signal: ConsumerSignal) {
  switch (signal.stage) {
    case 'delivered':
      return `delivered ${signal.eventId} attempt=${signal.attempt} redelivered=${signal.redelivered}`;
    case 'effect':
      return `${signal.eventId} ${signal.applied ? 'shipment created' : 'duplicate, effect skipped'}`;
    case 'settled':
      return `${signal.eventId} ${signal.outcome}${signal.outcome === 'retry' ? ` in ${RETRY_DELAY_MS} ms` : ''}${signal.error ? `: ${signal.error}` : ''}`;
  }
}

function report(signal: ConsumerSignal) {
  console.log(`${tag}: ${describe(signal)}`);
  return new Promise<void>((resolve) => {
    if (!process.send) return resolve();
    process.send(signal, undefined, undefined, () => {
      if (crashAfterEffect && signal.stage === 'effect' && signal.applied) {
        process.kill(process.pid, 'SIGKILL');
      }
      resolve();
    });
  });
}

async function main() {
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const connection = await amqp.connect(parseBrokerUrl(process.env));
  const fail = (reason: string) => {
    console.error(`${tag}: ${reason}`);
    process.exit(1);
  };
  connection.on('error', (err) => fail(err.message));
  connection.on('close', () => fail('connection closed'));

  console.log(`${tag}: consuming ${ORDER_PLACED_QUEUE}, prefetch=${PREFETCH}`);
  const consumer = await startConsumer(connection, dataSource, {
    observe: report,
    onClose: fail,
  });

  const shutdown = async () => {
    await consumer.stop();
    connection.removeAllListeners('close');
    await connection.close();
    await dataSource.destroy();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  if (process.send) process.once('disconnect', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
