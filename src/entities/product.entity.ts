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

@Entity('products')
@Check('chk_products_name_not_empty', 'length(name) > 0')
@Check('chk_products_price_cents', 'price_cents >= 0')
@Check('chk_products_status', "status IN ('active', 'archived')")
@Index('idx_products_search_vector', { synchronize: false })
export class Product {
  @PrimaryGeneratedColumn('identity', { type: 'bigint' })
  id: string;

  @Column({ name: 'seller_id', type: 'bigint' })
  sellerId: string;

  @ManyToOne(() => User, (user) => user.products, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'seller_id' })
  seller: Relation<User>;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ name: 'price_cents', type: 'integer' })
  priceCents: number;

  @Column({ type: 'text', default: 'active' })
  status: 'active' | 'archived';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({
    name: 'search_vector',
    type: 'tsvector',
    generatedType: 'STORED',
    asExpression: "to_tsvector('simple', name || ' ' || description)",
    select: false,
    insert: false,
    update: false,
  })
  searchVector: string;

  @OneToMany(() => OrderItem, (item) => item.product)
  orderItems: Relation<OrderItem[]>;
}
