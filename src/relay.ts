import { DataSource } from 'typeorm';
import { parseBrokerUrl } from './config/env.schema';
import { dataSourceOptions } from './data-source';
import { EventPublisher } from './events/publisher';
import { OutboxRelay, OutboxRow, RELAY_INTERVAL_MS } from './events/relay';

const tag = `relay ${process.pid}`;
const crashAfterPublish = process.env.RELAY_CRASH_AFTER_PUBLISH === '1';

function report(stage: 'published' | 'polled', data: Record<string, unknown>) {
  return new Promise<void>((resolve) => {
    if (!process.send) return resolve();
    process.send({ stage, ...data }, undefined, undefined, () => {
      if (crashAfterPublish && stage === 'published') {
        process.kill(process.pid, 'SIGKILL');
      }
      resolve();
    });
  });
}

async function main() {
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const publisher = new EventPublisher(parseBrokerUrl(process.env), (message) =>
    console.error(`${tag}: ${message}`),
  );
  await publisher.connect();

  const relay = new OutboxRelay(dataSource, publisher, {
    intervalMs: RELAY_INTERVAL_MS,
    afterPublish: async (row: OutboxRow) => {
      console.log(`${tag}: published outbox ${row.id} ${row.payload.eventId}`);
      await report('published', { id: row.id, eventId: row.payload.eventId });
    },
    afterPoll: (run) => report('polled', { ...run }),
    onError: (message) => console.error(`${tag}: ${message}`),
  });
  console.log(`${tag}: polling outbox every ${RELAY_INTERVAL_MS} ms`);
  relay.start();

  const shutdown = async () => {
    await relay.stop();
    await publisher.close();
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
