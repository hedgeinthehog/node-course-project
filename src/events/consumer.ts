import type { ChannelModel, ConsumeMessage } from 'amqplib';
import { DataSource } from 'typeorm';
import { OrderPlacedEvent, parseOrderPlaced } from './order-placed';
import { declareTopology, ORDER_PLACED_QUEUE } from './topology';

export const PREFETCH = 20;

export type ConsumerSignal =
  | { stage: 'delivered'; eventId: string | null; redelivered: boolean }
  | { stage: 'effect'; eventId: string; applied: boolean }
  | {
      stage: 'settled';
      eventId: string | null;
      outcome: 'ack' | 'requeue' | 'drop';
      error?: string;
    };

export interface ConsumerOptions {
  observe?: (signal: ConsumerSignal) => void | Promise<void>;
  onClose?: (reason: string) => void;
}

export interface RunningConsumer {
  stop(): Promise<void>;
}

export async function applyOrderPlaced(
  dataSource: DataSource,
  event: OrderPlacedEvent,
): Promise<boolean> {
  const inserted: { order_id: string }[] = await dataSource.query(
    `INSERT INTO shipments (order_id, event_id) VALUES ($1, $2)
     ON CONFLICT (order_id) DO NOTHING
     RETURNING order_id`,
    [event.payload.orderId, event.eventId],
  );
  return inserted.length === 1;
}

export async function startConsumer(
  connection: ChannelModel,
  dataSource: DataSource,
  { observe = () => undefined, onClose }: ConsumerOptions = {},
): Promise<RunningConsumer> {
  let stopping = false;
  const closed = (reason: string) => {
    if (stopping) return;
    stopping = true;
    onClose?.(reason);
  };
  const channel = await connection.createChannel();
  channel.on('error', (err) => closed(err.message));
  channel.on('close', () => closed('channel closed by the broker'));
  await declareTopology(channel);
  await channel.prefetch(PREFETCH);

  const handle = async (msg: ConsumeMessage) => {
    const messageId =
      typeof msg.properties.messageId === 'string'
        ? msg.properties.messageId
        : null;
    let event: OrderPlacedEvent;
    try {
      event = parseOrderPlaced(msg.content);
    } catch (err) {
      await observe({
        stage: 'delivered',
        eventId: messageId,
        redelivered: msg.fields.redelivered,
      });
      channel.reject(msg, false);
      await observe({
        stage: 'settled',
        eventId: messageId,
        outcome: 'drop',
        error: (err as Error).message,
      });
      return;
    }
    const { eventId } = event;
    await observe({
      stage: 'delivered',
      eventId,
      redelivered: msg.fields.redelivered,
    });
    let applied: boolean;
    try {
      applied = await applyOrderPlaced(dataSource, event);
    } catch (err) {
      channel.reject(msg, true);
      await observe({
        stage: 'settled',
        eventId,
        outcome: 'requeue',
        error: (err as Error).message,
      });
      return;
    }
    await observe({ stage: 'effect', eventId, applied });
    channel.ack(msg);
    await observe({ stage: 'settled', eventId, outcome: 'ack' });
  };

  const inFlight = new Set<Promise<void>>();
  const { consumerTag } = await channel.consume(
    ORDER_PLACED_QUEUE,
    (msg) => {
      if (!msg) return closed('consumer cancelled by the broker');
      const job: Promise<void> = handle(msg).finally(() =>
        inFlight.delete(job),
      );
      inFlight.add(job);
    },
    { noAck: false },
  );

  return {
    async stop() {
      stopping = true;
      await channel.cancel(consumerTag);
      await Promise.all(inFlight);
      await channel.close();
    },
  };
}
