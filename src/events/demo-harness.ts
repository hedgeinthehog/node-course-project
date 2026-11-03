import { ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import amqp from 'amqplib';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { DataSource } from 'typeorm';
import { parseBrokerUrl } from '../config/env.schema';
import { dataSourceOptions } from '../data-source';
import { Product } from '../entities/product.entity';
import { User } from '../entities/user.entity';
import { CreateOrderDto } from '../orders/dto/create-order.dto';
import { OrderDto } from '../orders/dto/order.dto';
import { placeOrder } from '../orders/place-order';
import { ConsumerSignal } from './consumer';
import { EventPublisher } from './publisher';
import { OutboxRelay, RelayRun } from './relay';
import {
  DEAD_LETTER_QUEUE,
  declareTopology,
  ORDER_PLACED_QUEUE,
  RETRY_QUEUE,
} from './topology';

const POLL_MS = 50;

export type RelaySignal =
  | { stage: 'published'; id: string; eventId: string }
  | ({ stage: 'polled' } & RelayRun);

export interface Buyer {
  buyerId: number;
  dto: CreateOrderDto;
}

export async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class SupervisedProcess<T> {
  readonly signals: T[] = [];
  readonly exited: Promise<{ code: number | null; signal: string | null }>;

  constructor(private readonly child: ChildProcess) {
    child.on('message', (signal) => this.signals.push(signal as T));
    this.exited = new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
  }

  count(predicate: (signal: T) => boolean): number {
    return this.signals.filter(predicate).length;
  }

  waitFor(predicate: (signals: T[]) => boolean, what: string) {
    return until(() => predicate(this.signals), what);
  }

  stop() {
    this.child.kill('SIGTERM');
    return this.exited;
  }
}

export class Harness {
  static async open(): Promise<Harness> {
    const dataSource = await new DataSource(dataSourceOptions).initialize();
    const url = parseBrokerUrl(process.env);
    const connection = await amqp.connect(url);
    const channel = await connection.createChannel();
    await declareTopology(channel);
    const { consumerCount } = await channel.checkQueue(ORDER_PLACED_QUEUE);
    if (consumerCount > 0) {
      throw new Error(
        `${consumerCount} consumer(s) are already attached to ${ORDER_PLACED_QUEUE}; stop "npm run consume" before running a demo`,
      );
    }
    for (const queue of [ORDER_PLACED_QUEUE, RETRY_QUEUE]) {
      await channel.purgeQueue(queue);
    }
    const deadLettersBefore = (await channel.checkQueue(DEAD_LETTER_QUEUE))
      .messageCount;
    const publisher = new EventPublisher(url);
    await publisher.connect();
    return new Harness(
      dataSource,
      connection,
      channel,
      publisher,
      deadLettersBefore,
    );
  }

  private constructor(
    readonly dataSource: DataSource,
    private readonly connection: ChannelModel,
    readonly channel: Channel,
    readonly publisher: EventPublisher,
    private readonly deadLettersBefore: number,
  ) {}

  async newBuyer(): Promise<Buyer> {
    const users = this.dataSource.getRepository(User);
    const run = randomUUID();
    const seller = await users.save(
      users.create({ email: `seller-${run}@demo.local`, name: 'Demo seller' }),
    );
    const buyer = await users.save(
      users.create({
        email: `buyer-${run}@demo.local`,
        name: 'Demo buyer',
        balanceCents: '100000',
      }),
    );
    const products = this.dataSource.getRepository(Product);
    const product = await products.save(
      products.create({
        sellerId: seller.id,
        name: `Demo product ${run}`,
        description: 'created by an events demo',
        priceCents: 2500,
        stock: 5,
      }),
    );
    return {
      buyerId: Number(buyer.id),
      dto: {
        user_id: Number(buyer.id),
        items: [{ product_id: Number(product.id), quantity: 1 }],
      },
    };
  }

  async placeOrder(key = `demo-${randomUUID()}`): Promise<OrderDto> {
    const { dto } = await this.newBuyer();
    return (await placeOrder(this.dataSource, key, dto)).result;
  }

  relay(): Promise<RelayRun> {
    return new OutboxRelay(this.dataSource, this.publisher).runOnce();
  }

  async depth(queue: string): Promise<number> {
    return (await this.channel.checkQueue(queue)).messageCount;
  }

  async deadLetters(): Promise<number> {
    return (await this.depth(DEAD_LETTER_QUEUE)) - this.deadLettersBefore;
  }

  async peekDeadLetters(): Promise<ConsumeMessage[]> {
    const expected = await this.depth(DEAD_LETTER_QUEUE);
    const seen: ConsumeMessage[] = [];
    if (expected === 0) return seen;
    const { consumerTag } = await this.channel.consume(
      DEAD_LETTER_QUEUE,
      (msg) => {
        if (msg) seen.push(msg);
      },
      { noAck: false },
    );
    await until(
      () => seen.length >= expected,
      'the dead-letter queue to be read',
    );
    await this.channel.cancel(consumerTag);
    this.channel.nackAll(true);
    await until(
      async () => (await this.depth(DEAD_LETTER_QUEUE)) === expected,
      'the dead letters to return to their queue',
    );
    return seen;
  }

  async ordersOf(buyerId: number): Promise<number> {
    return this.scalar(
      `SELECT count(*)::int AS value FROM orders WHERE user_id = $1`,
      [buyerId],
    );
  }

  async outboxOf(
    buyerId: number,
  ): Promise<{ total: number; published: number }> {
    const [row]: { total: number; published: number }[] =
      await this.dataSource.query(
        `SELECT count(*)::int AS total,
                count(published_at)::int AS published
         FROM outbox
         WHERE aggregate_type = 'order'
           AND (payload -> 'payload' ->> 'userId')::bigint = $1`,
        [buyerId],
      );
    return row;
  }

  async shipmentsOf(buyerId: number): Promise<number> {
    return this.scalar(
      `SELECT count(*)::int AS value
       FROM shipments s JOIN orders o ON o.id = s.order_id
       WHERE o.user_id = $1`,
      [buyerId],
    );
  }

  shipments(orderIds: number[]): Promise<number> {
    return this.scalar(
      `SELECT count(*)::int AS value FROM shipments WHERE order_id = ANY($1)`,
      [orderIds],
    );
  }

  processed(eventIds: string[]): Promise<number> {
    return this.scalar(
      `SELECT count(*)::int AS value FROM processed_messages WHERE message_id = ANY($1::uuid[])`,
      [eventIds],
    );
  }

  spawnConsumer(env: Record<string, string> = {}) {
    return this.spawn<ConsumerSignal>('consumer.js', env);
  }

  spawnRelay(env: Record<string, string> = {}) {
    return this.spawn<RelaySignal>('relay.js', env);
  }

  async close(): Promise<void> {
    await this.publisher.close();
    await this.connection.close();
    await this.dataSource.destroy();
  }

  private spawn<T>(script: string, env: Record<string, string>) {
    return new SupervisedProcess<T>(
      fork(join(__dirname, '..', script), [], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      }),
    );
  }

  private async scalar(sql: string, params: unknown[]): Promise<number> {
    const [{ value }]: { value: number }[] = await this.dataSource.query(
      sql,
      params,
    );
    return value;
  }
}

export function ownedBy(ids: Set<string>) {
  return (signal: { eventId: string | null }) =>
    signal.eventId !== null && ids.has(signal.eventId);
}

export function summary(values: Record<string, string | number>) {
  for (const [key, value] of Object.entries(values)) {
    console.log(`${key}=${value}`);
  }
}

export function finish(ok: boolean, verdict: string) {
  console.log(ok ? verdict : 'DEMO CHECK FAILED');
  process.exit(ok ? 0 : 1);
}
