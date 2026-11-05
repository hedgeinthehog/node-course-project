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

export type UserRole = 'buyer' | 'seller' | 'admin';

@Entity('users')
@Check('chk_users_name_not_empty', 'length(name) > 0')
@Check('chk_users_balance_cents', 'balance_cents >= 0')
@Check('chk_users_role', "role IN ('buyer', 'seller', 'admin')")
@Index('idx_users_lower_email', { synchronize: false })
export class User {
  @PrimaryGeneratedColumn('identity', { type: 'bigint' })
  id: string;

  @Column({ type: 'text', unique: true })
  email: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ name: 'balance_cents', type: 'bigint', default: 0 })
  balanceCents: string;

  @Column({ type: 'text', default: 'buyer' })
  role: UserRole;

  @Column({ name: 'password_hash', type: 'text', nullable: true })
  passwordHash: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @OneToMany(() => Product, (product) => product.seller)
  products: Relation<Product[]>;

  @OneToMany(() => Order, (order) => order.user)
  orders: Relation<Order[]>;
}
