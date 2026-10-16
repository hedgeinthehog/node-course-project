import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Observable, Subject } from 'rxjs';
import { EntityManager, MoreThan, Repository } from 'typeorm';
import { OrderEvent } from '../entities/order-event.entity';
import { OrderStatus } from './order-status';

export interface OrderStatusEvent {
  id: number;
  orderId: number;
  status: OrderStatus;
  previous: OrderStatus;
  at: string;
}

const toEvent = (row: OrderEvent): OrderStatusEvent => ({
  id: row.seq,
  orderId: Number(row.orderId),
  status: row.status,
  previous: row.previous,
  at: row.createdAt.toISOString(),
});

@Injectable()
export class OrderEventsService {
  private readonly subject = new Subject<OrderStatusEvent>();

  constructor(
    @InjectRepository(OrderEvent)
    private readonly events: Repository<OrderEvent>,
  ) {}

  async record(
    manager: EntityManager,
    orderId: string,
    change: { status: OrderStatus; previous: OrderStatus },
  ): Promise<OrderStatusEvent> {
    const [{ next }]: { next: number }[] = await manager.query(
      'SELECT coalesce(max(seq), 0) + 1 AS next FROM order_events WHERE order_id = $1',
      [orderId],
    );
    const row = await manager.save(
      manager.create(OrderEvent, { orderId, seq: next, ...change }),
    );
    return toEvent(row);
  }

  publish(event: OrderStatusEvent) {
    this.subject.next(event);
  }

  all(): Observable<OrderStatusEvent> {
    return this.subject.asObservable();
  }

  async missed(orderId: number, afterId: number): Promise<OrderStatusEvent[]> {
    const rows = await this.events.find({
      where: { orderId: String(orderId), seq: MoreThan(afterId) },
      order: { seq: 'ASC' },
    });
    return rows.map(toEvent);
  }

  stream(orderId: number, afterId = 0): Observable<OrderStatusEvent> {
    return new Observable((subscriber) => {
      const pending: OrderStatusEvent[] = [];
      let replayed = false;
      let last = afterId;
      const deliver = (event: OrderStatusEvent) => {
        if (event.id > last) {
          last = event.id;
          subscriber.next(event);
        }
      };
      const live = this.subject.subscribe((event) => {
        if (event.orderId !== orderId) return;
        if (replayed) deliver(event);
        else pending.push(event);
      });
      this.missed(orderId, afterId).then(
        (rows) => {
          rows.forEach(deliver);
          replayed = true;
          pending.splice(0).forEach(deliver);
        },
        (error) => subscriber.error(error),
      );
      return () => live.unsubscribe();
    });
  }
}
