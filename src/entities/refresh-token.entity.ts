import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { User } from './user.entity';

@Entity('refresh_tokens')
@Index('idx_refresh_tokens_family_id', ['familyId'])
export class RefreshToken {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ name: 'user_id', type: 'bigint' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @Column({ name: 'family_id', type: 'uuid' })
  familyId: string;

  @Index('idx_refresh_tokens_token_hash', { unique: true })
  @Column({ name: 'token_hash', type: 'text' })
  tokenHash: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;
}
