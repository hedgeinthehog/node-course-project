import type { Channel } from 'amqplib';
import { ORDER_PLACED } from './order-placed';

export const EVENTS_EXCHANGE = 'shop.events';
export const UNROUTED_EXCHANGE = 'shop.events.unrouted';
export const UNROUTED_QUEUE = 'shop.events.unrouted';
export const DEAD_LETTER_EXCHANGE = 'shop.events.dlx';
export const DEAD_LETTER_QUEUE = 'shop.events.dlq';
export const ORDER_PLACED_QUEUE = 'fulfillment.order-placed';
export const DELIVERY_LIMIT = 3;

export async function declareTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'fanout', {
    durable: true,
  });
  await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
  await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, '');

  await channel.assertExchange(UNROUTED_EXCHANGE, 'fanout', { durable: true });
  await channel.assertQueue(UNROUTED_QUEUE, { durable: true });
  await channel.bindQueue(UNROUTED_QUEUE, UNROUTED_EXCHANGE, '');

  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', {
    durable: true,
    alternateExchange: UNROUTED_EXCHANGE,
  });
  await channel.assertQueue(ORDER_PLACED_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
      'x-delivery-limit': DELIVERY_LIMIT,
    },
  });
  await channel.bindQueue(ORDER_PLACED_QUEUE, EVENTS_EXCHANGE, ORDER_PLACED);
}
