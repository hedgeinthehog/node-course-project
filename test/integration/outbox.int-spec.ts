import amqp from 'amqplib';
import type { Channel, ChannelModel } from 'amqplib';
import { DataSource } from 'typeorm';
import { checkout } from '../../src/checkout/checkout';
import {
  IdempotencyKeyReuseError,
  IdempotencyStore,
} from '../../src/common/idempotency';
import { Order } from '../../src/entities/order.entity';
import { OutboxEvent } from '../../src/entities/outbox-event.entity';
import { ProcessedMessage } from '../../src/entities/processed-message.entity';
import { Shipment } from '../../src/entities/shipment.entity';
import {
  ConsumerSignal,
  RunningConsumer,
  startConsumer,
} from '../../src/events/consumer';
import { orderPlaced } from '../../src/events/order-placed';
import { EventPublisher } from '../../src/events/publisher';
import { OutboxRelay } from '../../src/events/relay';
import { ORDER_PLACED_QUEUE } from '../../src/events/topology';
import { toOrderDto } from '../../src/orders/dto/order.dto';
import { placeOrder } from '../../src/orders/place-order';
import { given } from './testkit/builders';
import { connect, resetDatabase } from './testkit/database';

async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('transactional outbox', () => {
  let dataSource: DataSource;
  let connection: ChannelModel;
  let channel: Channel;
  let publisher: EventPublisher;
  let consumer: RunningConsumer | undefined;
  const signals: ConsumerSignal[] = [];

  const outboxRows = () => dataSource.getRepository(OutboxEvent).find();
  const orderFor = async () => {
    const { user, product } = given(dataSource);
    const buyer = await user();
    const keyboard = await product({ stock: 5 });
    return {
      dto: {
        user_id: Number(buyer.id),
        items: [{ product_id: Number(keyboard.id), quantity: 1 }],
      },
      input: {
        userId: buyer.id,
        items: [{ productId: keyboard.id, quantity: 1 }],
      },
    };
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
    signals.length = 0;
  });
  afterEach(async () => {
    await consumer?.stop();
    consumer = undefined;
  });

  it('commits the order and its outbox row together', async () => {
    const { input } = await orderFor();

    const order = await checkout(dataSource, input);

    await expect(outboxRows()).resolves.toEqual([
      expect.objectContaining({
        aggregateType: 'order',
        aggregateId: order.id,
        type: 'order.placed',
        payload: orderPlaced(toOrderDto(order)),
        publishedAt: null,
        attempts: 0,
      }),
    ]);
  });

  it('rolls the outbox row back together with a business write that fails after it', async () => {
    const { input } = await orderFor();
    let rowsInsideTransaction = 0;

    const attempt = dataSource.transaction(async (manager) => {
      await checkout(manager, input);
      rowsInsideTransaction = await manager.count(OutboxEvent);
      throw new Error('crash after the outbox insert');
    });

    await expect(attempt).rejects.toThrow('crash after the outbox insert');
    expect(rowsInsideTransaction).toBe(1);
    await expect(outboxRows()).resolves.toEqual([]);
    await expect(dataSource.getRepository(Order).count()).resolves.toBe(0);
  });

  it('makes a repeated Idempotency-Key replay the first order and rejects the key with another body', async () => {
    const { dto } = await orderFor();

    const first = await placeOrder(dataSource, 'order-key', dto);
    const replay = await placeOrder(dataSource, 'order-key', dto);
    const reuse = placeOrder(dataSource, 'order-key', {
      ...dto,
      items: [{ ...dto.items[0], quantity: 2 }],
    });

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ result: first.result, replayed: true });
    await expect(reuse).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
    await expect(dataSource.getRepository(Order).count()).resolves.toBe(1);
    await expect(outboxRows()).resolves.toHaveLength(1);
  });

  it('serialises concurrent requests with the same key into one order', async () => {
    const { dto } = await orderFor();

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => placeOrder(dataSource, 'race-key', dto)),
    );

    expect(outcomes.filter((o) => !o.replayed)).toHaveLength(1);
    expect(new Set(outcomes.map((o) => o.result.id)).size).toBe(1);
    await expect(dataSource.getRepository(Order).count()).resolves.toBe(1);
  });

  it('does not store a key whose request failed, so the client can retry it', async () => {
    const { dto } = await orderFor();
    const store = new IdempotencyStore(dataSource);

    await expect(
      store.run('failing-key', dto, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    const retried = await placeOrder(dataSource, 'failing-key', dto);

    expect(retried.replayed).toBe(false);
  });

  it('relay publishes unpublished rows in order and marks them published', async () => {
    const { input } = await orderFor();
    const a = await checkout(dataSource, input);
    const b = await checkout(dataSource, input);

    const run = await new OutboxRelay(dataSource, publisher).runOnce();
    const again = await new OutboxRelay(dataSource, publisher).runOnce();

    expect(run).toEqual({ published: 2, failed: 0 });
    expect(again).toEqual({ published: 0, failed: 0 });
    const rows = await outboxRows();
    expect(rows.map((r) => [r.aggregateId, r.attempts])).toEqual([
      [a.id, 1],
      [b.id, 1],
    ]);
    expect(rows.every((r) => r.publishedAt !== null)).toBe(true);
    const first = await channel.get(ORDER_PLACED_QUEUE, { noAck: true });
    const second = await channel.get(ORDER_PLACED_QUEUE, { noAck: true });
    expect(first && JSON.parse(first.content.toString()).payload.orderId).toBe(
      Number(a.id),
    );
    expect(
      second && JSON.parse(second.content.toString()).payload.orderId,
    ).toBe(Number(b.id));
    await expect(
      channel.get(ORDER_PLACED_QUEUE, { noAck: true }),
    ).resolves.toBe(false);
  });

  it('republishes after a relay crash between publish and UPDATE, and the consumer applies the event once', async () => {
    consumer = await startConsumer(connection, dataSource, {
      observe: (signal) => void signals.push(signal),
    });
    const { input } = await orderFor();
    const order = await checkout(dataSource, input);
    const event = orderPlaced(toOrderDto(order));

    const crashing = new OutboxRelay(dataSource, publisher, {
      afterPublish: () => {
        throw new Error('relay crashed after publish');
      },
    });
    await expect(crashing.runOnce()).rejects.toThrow(
      'relay crashed after publish',
    );
    await expect(
      dataSource.getRepository(OutboxEvent).findOneByOrFail({ id: '1' }),
    ).resolves.toMatchObject({ publishedAt: null, attempts: 0 });

    const run = await new OutboxRelay(dataSource, publisher).runOnce();
    await until(
      () => signals.filter((s) => s.stage === 'settled').length === 2,
    );

    expect(run).toEqual({ published: 1, failed: 0 });
    expect(
      signals.filter((s) => s.stage === 'delivered').map((s) => s.eventId),
    ).toEqual([event.eventId, event.eventId]);
    expect(
      signals.filter((s) => s.stage === 'effect').map((s) => s.applied),
    ).toEqual([true, false]);
    await expect(dataSource.getRepository(Shipment).count()).resolves.toBe(1);
    await expect(
      dataSource.getRepository(ProcessedMessage).find(),
    ).resolves.toEqual([
      expect.objectContaining({
        messageId: event.eventId,
        consumer: 'fulfillment',
      }),
    ]);
  });
});
