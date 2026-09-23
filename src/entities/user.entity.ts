import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { Order } from './order.entity';
import { Product } from './product.entity';

@Entity('users')
@Check('chk_users_name_not_empty', 'length(name) > 0')
@Index('idx_users_lower_email', { synchronize: false })
export class User {
  @PrimaryGeneratedColumn('identity', { type: 'bigint' })
  id: string;

  @Column({ type: 'text', unique: true })
  email: string;

  @Column({ type: 'text' })
  name: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @OneToMany(() => Product, (product) => product.seller)
  products: Relation<Product[]>;

  @OneToMany(() => Order, (order) => order.user)
  orders: Relation<Order[]>;
}
