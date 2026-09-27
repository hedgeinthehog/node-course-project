import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { OrderItem } from './order-item.entity';
import { User } from './user.entity';

@Entity('orders')
@Check('chk_orders_status', "status IN ('pending', 'paid', 'cancelled')")
@Check('chk_orders_total_cents', 'total_cents >= 0')
@Index('idx_orders_user_id_created_at', { synchronize: false })
@Index('idx_orders_pending_created_at', { synchronize: false })
export class Order {
  @PrimaryGeneratedColumn('identity', { type: 'bigint' })
  id: string;

  @Column({ name: 'user_id', type: 'bigint' })
  userId: string;

  @ManyToOne(() => User, (user) => user.orders, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @Column({ type: 'text', default: 'pending' })
  status: 'pending' | 'paid' | 'cancelled';

  @Column({ name: 'total_cents', type: 'bigint' })
  totalCents: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @OneToMany(() => OrderItem, (item) => item.order)
  items: Relation<OrderItem[]>;
}
