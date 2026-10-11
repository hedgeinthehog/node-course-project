import { Injectable } from '@nestjs/common';
import { concat, filter, from, Observable, Subject } from 'rxjs';
import { OrderStatus } from './order-status';

export interface OrderStatusEvent {
  id: number;
  orderId: number;
  status: OrderStatus;
  previous: OrderStatus;
  at: string;
}

const BUFFER_SIZE = 100;
const TRACKED_ORDERS = 10_000;

@Injectable()
export class OrderEventsService {
  private readonly subject = new Subject<OrderStatusEvent>();
  private readonly buffers = new Map<number, OrderStatusEvent[]>();

  publish(
    orderId: number,
    change: { status: OrderStatus; previous: OrderStatus },
  ): OrderStatusEvent {
    const buffer = this.buffers.get(orderId) ?? [];
    const event: OrderStatusEvent = {
      id: (buffer.at(-1)?.id ?? 0) + 1,
      orderId,
      ...change,
      at: new Date().toISOString(),
    };
    buffer.push(event);
    this.buffers.delete(orderId);
    this.buffers.set(orderId, buffer.slice(-BUFFER_SIZE));
    if (this.buffers.size > TRACKED_ORDERS) {
      this.buffers.delete(this.buffers.keys().next().value!);
    }
    this.subject.next(event);
    return event;
  }

  all(): Observable<OrderStatusEvent> {
    return this.subject.asObservable();
  }

  missed(orderId: number, afterId: number): OrderStatusEvent[] {
    return (this.buffers.get(orderId) ?? []).filter(
      (event) => event.id > afterId,
    );
  }

  stream(orderId: number, afterId = 0): Observable<OrderStatusEvent> {
    const missed = this.missed(orderId, afterId);
    const lastReplayed = missed.at(-1)?.id ?? afterId;
    return concat(
      from(missed),
      this.subject.pipe(
        filter((event) => event.orderId === orderId && event.id > lastReplayed),
      ),
    );
  }
}
