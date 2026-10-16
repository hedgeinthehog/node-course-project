import amqp from 'amqplib';
import type { Channel, ChannelModel } from 'amqplib';
import { DataSource } from 'typeorm';
import { Shipment } from '../../src/entities/shipment.entity';
import {
  ConsumerSignal,
  startConsumer,
  RunningConsumer,
} from '../../src/events/consumer';
import { ORDER_PLACED, orderPlaced } from '../../src/events/order-placed';
import { EventPublisher } from '../../src/events/publisher';
import {
  DEAD_LETTER_QUEUE,
  DELIVERY_LIMIT,
  EVENTS_EXCHANGE,
  ORDER_PLACED_QUEUE,
} from '../../src/events/topology';
import { toOrderDto } from '../../src/orders/dto/order.dto';
import { given } from './testkit/builders';
import { connect, resetDatabase } from './testkit/database';

async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('order.placed consumer', () => {
  let dataSource: DataSource;
  let connection: ChannelModel;
  let channel: Channel;
  let publisher: EventPublisher;
  let consumer: RunningConsumer;
  const signals: ConsumerSignal[] = [];

  const settled = () => signals.filter((s) => s.stage === 'settled');
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
    await channel.purgeQueue(ORDER_PLACED_QUEUE);
    await channel.purgeQueue(DEAD_LETTER_QUEUE);
    signals.length = 0;
    consumer = await startConsumer(connection, dataSource, {
      observe: (signal) => void signals.push(signal),
    });
  });
  afterEach(() => consumer.stop());

  it('creates the shipment once and skips the duplicate delivery of the same event', async () => {
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

  it('requeues an event whose effect fails and dead-letters it after the delivery limit', async () => {
    const event = orderPlaced({
      id: 424242,
      user_id: 1,
      items: [{ product_id: 1, quantity: 1 }],
      total_cents: 100,
      status: 'paid',
      created_at: new Date().toISOString(),
    });

    await publisher.publish(event);
    const dead = await deadLetter();

    expect(settled().map((s) => s.outcome)).toEqual(
      Array(DELIVERY_LIMIT + 1).fill('requeue'),
    );
    expect(
      signals.filter((s) => s.stage === 'delivered' && s.redelivered),
    ).toHaveLength(DELIVERY_LIMIT);
    expect(dead.properties.headers?.['x-first-death-reason']).toBe(
      'delivery_limit',
    );
    expect(JSON.parse(dead.content.toString())).toEqual(event);
    await expect(dataSource.getRepository(Shipment).count()).resolves.toBe(0);
  });

  it('rejects a message that violates the contract without retrying it', async () => {
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
});
