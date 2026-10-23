import type { ChannelModel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import { DataSource } from 'typeorm';
import { OrderPlacedEvent, parseOrderPlaced } from './order-placed';
import { declareTopology, ORDER_PLACED_QUEUE, RETRY_QUEUE } from './topology';

export const PREFETCH = 20;
export const MAX_RETRIES = 3;
const RETRY_HEADER = 'x-retry';

export type ConsumerSignal =
  | {
      stage: 'delivered';
      eventId: string | null;
      attempt: number;
      redelivered: boolean;
    }
  | { stage: 'effect'; eventId: string; applied: boolean }
  | {
      stage: 'settled';
      eventId: string | null;
      outcome: 'ack' | 'retry' | 'drop';
      error?: string;
    };

export interface ConsumerOptions {
  observe?: (signal: ConsumerSignal) => void | Promise<void>;
  onClose?: (reason: string) => void;
}

export interface RunningConsumer {
  stop(): Promise<void>;
}

export const CONSUMER_NAME = 'fulfillment';

export function applyOrderPlaced(
  dataSource: DataSource,
  event: OrderPlacedEvent,
): Promise<boolean> {
  return dataSource.transaction(async (manager) => {
    const marked: { message_id: string }[] = await manager.query(
      `INSERT INTO processed_messages (message_id, consumer) VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING message_id`,
      [event.eventId, CONSUMER_NAME],
    );
    if (marked.length === 0) return false;
    await manager.query(
      `INSERT INTO shipments (order_id, event_id) VALUES ($1, $2)
       ON CONFLICT (order_id) DO NOTHING`,
      [event.payload.orderId, event.eventId],
    );
    return true;
  });
}

function scheduleRetry(
  channel: ConfirmChannel,
  msg: ConsumeMessage,
  retry: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    channel.sendToQueue(
      RETRY_QUEUE,
      msg.content,
      {
        ...msg.properties,
        headers: { ...msg.properties.headers, [RETRY_HEADER]: retry },
      },
      (err) => (err ? reject(err) : resolve()),
    );
  });
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
  const channel = await connection.createConfirmChannel();
  channel.on('error', (err) => closed(err.message));
  channel.on('close', () => closed('channel closed by the broker'));
  await declareTopology(channel);
  await channel.prefetch(PREFETCH);

  const handle = async (msg: ConsumeMessage) => {
    const messageId =
      typeof msg.properties.messageId === 'string'
        ? msg.properties.messageId
        : null;
    const retries = Number(msg.properties.headers?.[RETRY_HEADER] ?? 0);
    let event: OrderPlacedEvent;
    try {
      event = parseOrderPlaced(msg.content);
    } catch (err) {
      await observe({
        stage: 'delivered',
        eventId: messageId,
        attempt: retries + 1,
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
      attempt: retries + 1,
      redelivered: msg.fields.redelivered,
    });
    let applied: boolean;
    try {
      applied = await applyOrderPlaced(dataSource, event);
    } catch (err) {
      const error = (err as Error).message;
      if (retries < MAX_RETRIES) {
        await scheduleRetry(channel, msg, retries + 1);
        channel.ack(msg);
        await observe({ stage: 'settled', eventId, outcome: 'retry', error });
      } else {
        channel.reject(msg, false);
        await observe({ stage: 'settled', eventId, outcome: 'drop', error });
      }
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
