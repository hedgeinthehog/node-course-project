import amqp from 'amqplib';
import { parseBrokerUrl } from './config/env.schema';
import {
  DEAD_LETTER_QUEUE,
  declareTopology,
  EVENTS_EXCHANGE,
  ORDER_PLACED_QUEUE,
} from './events/topology';

async function main() {
  const connection = await amqp.connect(parseBrokerUrl(process.env));
  const channel = await connection.createChannel();
  await declareTopology(channel);
  await connection.close();
  console.log(
    `declared exchange ${EVENTS_EXCHANGE}, queue ${ORDER_PLACED_QUEUE} and dead-letter queue ${DEAD_LETTER_QUEUE}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
