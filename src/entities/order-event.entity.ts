import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import type { OrderStatus } from '../orders/order-status';
import { Order } from './order.entity';

const STATUS_LIST =
  "('pending', 'paid', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled')";

@Entity('order_events')
@Check('chk_order_events_seq', 'seq > 0')
@Check('chk_order_events_status', `status IN ${STATUS_LIST}`)
@Check('chk_order_events_previous', `previous IN ${STATUS_LIST}`)
export class OrderEvent {
  @PrimaryColumn({ name: 'order_id', type: 'bigint' })
  orderId: string;

  @PrimaryColumn({ type: 'integer' })
  seq: number;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Relation<Order>;

  @Column({ type: 'text' })
  status: OrderStatus;

  @Column({ type: 'text' })
  previous: OrderStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
