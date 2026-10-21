import { ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import amqp from 'amqplib';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { DataSource } from 'typeorm';
import { checkout } from '../checkout/checkout';
import { parseBrokerUrl } from '../config/env.schema';
import { dataSourceOptions } from '../data-source';
import { Product } from '../entities/product.entity';
import { User } from '../entities/user.entity';
import { OrderDto, toOrderDto } from '../orders/dto/order.dto';
import { ConsumerSignal } from './consumer';
import { orderPlaced } from './order-placed';
import { EventPublisher } from './publisher';
import {
  DEAD_LETTER_QUEUE,
  declareTopology,
  ORDER_PLACED_QUEUE,
  RETRY_QUEUE,
} from './topology';

const POLL_MS = 50;

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

export class ConsumerProcess {
  readonly signals: ConsumerSignal[] = [];
  readonly exited: Promise<{ code: number | null; signal: string | null }>;

  constructor(private readonly child: ChildProcess) {
    child.on('message', (signal) =>
      this.signals.push(signal as ConsumerSignal),
    );
    this.exited = new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
  }

  count(predicate: (signal: ConsumerSignal) => boolean): number {
    return this.signals.filter(predicate).length;
  }

  waitFor(predicate: (signals: ConsumerSignal[]) => boolean, what: string) {
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

  async placeOrder(): Promise<OrderDto> {
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
        stock: 1,
      }),
    );
    const order = await checkout(this.dataSource, {
      userId: buyer.id,
      items: [{ productId: product.id, quantity: 1 }],
    });
    return toOrderDto(order);
  }

  publish(order: OrderDto) {
    return this.publisher.publish(orderPlaced(order));
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

  async shipments(orderIds: number[]): Promise<number> {
    const [{ count }]: { count: number }[] = await this.dataSource.query(
      `SELECT count(*)::int AS count FROM shipments WHERE order_id = ANY($1)`,
      [orderIds],
    );
    return count;
  }

  spawnConsumer(env: Record<string, string> = {}): ConsumerProcess {
    return new ConsumerProcess(
      fork(join(__dirname, '..', 'consumer.js'), [], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      }),
    );
  }

  async close(): Promise<void> {
    await this.publisher.close();
    await this.connection.close();
    await this.dataSource.destroy();
  }
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
