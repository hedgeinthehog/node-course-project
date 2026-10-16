import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { OrderDto } from '../orders/dto/order.dto';

export const ORDER_PLACED = 'order.placed';

export interface DomainEvent<T extends string, P> {
  eventId: string;
  type: T;
  occurredAt: string;
  payload: P;
}

const orderPlacedSchema = z.object({
  eventId: z.uuid(),
  type: z.literal(ORDER_PLACED),
  occurredAt: z.iso.datetime(),
  payload: z.object({
    orderId: z.int().positive(),
    userId: z.int().positive(),
    totalCents: z.int().nonnegative(),
    items: z
      .array(
        z.object({
          productId: z.int().positive(),
          quantity: z.int().positive(),
        }),
      )
      .min(1),
  }),
});

export type OrderPlacedEvent = z.infer<typeof orderPlacedSchema>;

export function eventIdFor(type: string, key: string | number): string {
  const hex = createHash('sha1')
    .update(`${type}:${key}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const id = hex.join('');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

export function orderPlaced(order: OrderDto): OrderPlacedEvent {
  return {
    eventId: eventIdFor(ORDER_PLACED, order.id),
    type: ORDER_PLACED,
    occurredAt: order.created_at,
    payload: {
      orderId: order.id,
      userId: order.user_id,
      totalCents: order.total_cents,
      items: order.items.map(({ product_id, quantity }) => ({
        productId: product_id,
        quantity,
      })),
    },
  };
}

export function parseOrderPlaced(content: Buffer): OrderPlacedEvent {
  return orderPlacedSchema.parse(JSON.parse(content.toString('utf8')));
}
