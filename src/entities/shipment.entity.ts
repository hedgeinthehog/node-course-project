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
import { Order } from './order.entity';

@Entity('shipments')
@Check('chk_shipments_status', "status IN ('pending', 'shipped', 'delivered')")
export class Shipment {
  @PrimaryColumn({ name: 'order_id', type: 'bigint' })
  orderId: string;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Relation<Order>;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @Column({ type: 'text', default: 'pending' })
  status: 'pending' | 'shipped' | 'delivered';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
