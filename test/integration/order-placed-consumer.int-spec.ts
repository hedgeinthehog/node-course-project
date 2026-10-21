import amqp from 'amqplib';
import type { Channel, ChannelModel } from 'amqplib';
import { DataSource } from 'typeorm';
import { Shipment } from '../../src/entities/shipment.entity';
import {
  ConsumerSignal,
  MAX_RETRIES,
  RunningConsumer,
  startConsumer,
} from '../../src/events/consumer';
import { ORDER_PLACED, orderPlaced } from '../../src/events/order-placed';
import { EventPublisher } from '../../src/events/publisher';
import {
  DEAD_LETTER_QUEUE,
  DELIVERY_LIMIT,
  EVENTS_EXCHANGE,
  ORDER_PLACED_QUEUE,
  RETRY_DELAY_MS,
  RETRY_QUEUE,
} from '../../src/events/topology';
import { toOrderDto } from '../../src/orders/dto/order.dto';
import { given } from './testkit/builders';
import { connect, resetDatabase } from './testkit/database';

async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 30_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const missingOrder = () =>
  orderPlaced({
    id: 424242,
    user_id: 1,
    items: [{ product_id: 1, quantity: 1 }],
    total_cents: 100,
    status: 'paid',
    created_at: new Date().toISOString(),
  });

describe('order.placed consumer', () => {
  let dataSource: DataSource;
  let connection: ChannelModel;
  let channel: Channel;
  let publisher: EventPublisher;
  let consumer: RunningConsumer | undefined;
  const signals: ConsumerSignal[] = [];

  const settled = () => signals.filter((s) => s.stage === 'settled');
  const run = async () => {
    consumer = await startConsumer(connection, dataSource, {
      observe: (signal) => void signals.push(signal),
    });
  };
  const deadLetter = async () => {
    await until(
      async () =>
        (await channel.checkQueue(DEAD_LETTER_QUEUE)).messageCount === 1,
    );
    const message = await channel.get(DEAD_LETTER_QUEUE, { noAck: true });
    if (!message) throw new Error('dead-letter queue is empty');
    return message;
  };

  beforeAll(async () => {
    dataSource = await connect();
    connection = await amqp.connect(process.env.BROKER_URL!);
    channel = await connection.createChannel();
    publisher = new EventPublisher(process.env.BROKER_URL!);
    await publisher.connect();
  });
  afterAll(async () => {
    await publisher.close();
    await connection.close();
    await dataSource.destroy();
  });
  beforeEach(async () => {
    await resetDatabase(dataSource);
    for (const queue of [ORDER_PLACED_QUEUE, RETRY_QUEUE, DEAD_LETTER_QUEUE]) {
      await channel.purgeQueue(queue);
    }
    signals.length = 0;
  });
  afterEach(async () => {
    await consumer?.stop();
    consumer = undefined;
  });

  it('creates the shipment once and skips the duplicate delivery of the same event', async () => {
    await run();
    const { order } = given(dataSource);
    const placed = await order();
    const event = orderPlaced(toOrderDto(placed));
    expect(event.eventId).toBe(orderPlaced(toOrderDto(placed)).eventId);

    await publisher.publish(event);
    await publisher.publish(event);
    await until(() => settled().length === 2);

    expect(
      signals.filter((s) => s.stage === 'effect').map((s) => s.applied),
    ).toEqual([true, false]);
    expect(settled().map((s) => s.outcome)).toEqual(['ack', 'ack']);
    await expect(dataSource.getRepository(Shipment).find()).resolves.toEqual([
      expect.objectContaining({
        orderId: placed.id,
        eventId: event.eventId,
        status: 'pending',
      }),
    ]);
  });

  it('retries a failing effect through the delayed retry queue and dead-letters it after the retry limit', async () => {
    await run();
    const event = missingOrder();
    const started = Date.now();

    await publisher.publish(event);
    const dead = await deadLetter();

    expect(Date.now() - started).toBeGreaterThanOrEqual(
      MAX_RETRIES * RETRY_DELAY_MS * 0.9,
    );
    expect(settled().map((s) => s.outcome)).toEqual([
      ...Array<string>(MAX_RETRIES).fill('retry'),
      'drop',
    ]);
    expect(
      signals.filter((s) => s.stage === 'delivered').map((s) => s.attempt),
    ).toEqual([1, 2, 3, 4]);
    expect(dead.properties.headers?.['x-death']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          queue: ORDER_PLACED_QUEUE,
          reason: 'rejected',
          count: 1,
        }),
        expect.objectContaining({ queue: RETRY_QUEUE, reason: 'expired' }),
      ]),
    );
    expect(dead.properties.headers?.['x-last-death-reason']).toBe('rejected');
    expect(JSON.parse(dead.content.toString())).toEqual(event);
    await expect(dataSource.getRepository(Shipment).count()).resolves.toBe(0);
  });

  it('rejects a message that violates the contract without retrying it', async () => {
    await run();
    channel.publish(
      EVENTS_EXCHANGE,
      ORDER_PLACED,
      Buffer.from('{"type":"order.placed","payload":"garbage"}'),
      { persistent: true, messageId: 'broken-1' },
    );
    const dead = await deadLetter();

    expect(settled()).toEqual([
      expect.objectContaining({
        eventId: 'broken-1',
        outcome: 'drop',
        error: expect.stringContaining('eventId'),
      }),
    ]);
    expect(dead.properties.headers?.['x-first-death-reason']).toBe('rejected');
    expect(dead.properties.headers?.['x-death']?.[0]?.count).toBe(1);
  });

  it('dead-letters a message that keeps coming back unacked after the delivery limit (crash-loop guard)', async () => {
    const crashing = await connection.createChannel();
    let deliveries = 0;
    const { consumerTag } = await crashing.consume(
      ORDER_PLACED_QUEUE,
      (msg) => {
        if (!msg) return;
        deliveries++;
        crashing.reject(msg, true);
      },
      { noAck: false },
    );

    await publisher.publish(missingOrder());
    const dead = await deadLetter();
    await crashing.cancel(consumerTag);
    await crashing.close();

    expect(deliveries).toBe(DELIVERY_LIMIT + 1);
    expect(dead.properties.headers?.['x-first-death-reason']).toBe(
      'delivery_limit',
    );
  });
});
