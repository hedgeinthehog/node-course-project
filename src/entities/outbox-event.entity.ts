import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('outbox')
@Index('idx_outbox_unpublished', ['createdAt', 'id'], {
  where: 'published_at IS NULL',
})
export class OutboxEvent {
  @PrimaryGeneratedColumn('identity', { type: 'bigint' })
  id: string;

  @Column({ name: 'aggregate_type', type: 'text' })
  aggregateType: string;

  @Column({ name: 'aggregate_id', type: 'text' })
  aggregateId: string;

  @Column({ type: 'text' })
  type: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'integer', default: 0 })
  attempts: number;
}
