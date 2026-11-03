import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import amqp from 'amqplib';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import { DomainEvent } from './order-placed';
import { DEAD_LETTER_EXCHANGE, EVENTS_EXCHANGE } from './topology';

const reason = (err: unknown) =>
  err instanceof AggregateError
    ? err.errors.map((inner) => (inner as Error).message).join(', ')
    : (err as Error).message;

export class EventPublisher implements OnModuleInit, OnModuleDestroy {
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private opening: Promise<ConfirmChannel> | null = null;

  constructor(
    private readonly url: string,
    private readonly onError: (message: string) => void = console.error,
  ) {}

  onModuleInit() {
    return this.connect();
  }

  onModuleDestroy() {
    return this.close();
  }

  async connect(): Promise<void> {
    await this.open();
  }

  publish(event: DomainEvent<string, unknown>): Promise<void> {
    return this.send(EVENTS_EXCHANGE, event);
  }

  deadLetter(event: DomainEvent<string, unknown>, reason: string) {
    return this.send(DEAD_LETTER_EXCHANGE, event, {
      'x-relay-failure': reason,
    });
  }

  private async send(
    exchange: string,
    event: DomainEvent<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<void> {
    const channel = this.channel ?? (await this.open());
    channel.publish(exchange, event.type, Buffer.from(JSON.stringify(event)), {
      persistent: true,
      contentType: 'application/json',
      messageId: event.eventId,
      type: event.type,
      timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
      headers,
    });
    await channel.waitForConfirms();
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.channel = null;
    await connection?.close();
  }

  private open(): Promise<ConfirmChannel> {
    this.opening ??= this.connectAndCheck().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async connectAndCheck(): Promise<ConfirmChannel> {
    let connection: ChannelModel;
    try {
      connection = await amqp.connect(this.url);
    } catch (err) {
      throw new Error(`cannot connect to the broker: ${reason(err)}`);
    }
    connection.on('error', (err) => this.onError(err.message));
    connection.on('close', () => {
      if (this.connection === connection) {
        this.connection = null;
        this.channel = null;
      }
    });
    const channel = await connection.createConfirmChannel();
    channel.on('error', (err) => this.onError(err.message));
    try {
      await channel.checkExchange(EVENTS_EXCHANGE);
    } catch (err) {
      await connection.close();
      throw new Error(
        `exchange ${EVENTS_EXCHANGE} is not declared, run "npm run events:topology" or start the consumer first: ${reason(err)}`,
      );
    }
    this.connection = connection;
    this.channel = channel;
    return channel;
  }
}
