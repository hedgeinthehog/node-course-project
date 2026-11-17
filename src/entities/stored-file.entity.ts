import {
  Check,
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

export type FileStatus = 'pending' | 'completed';

@Entity('files')
@Check('chk_files_status', "status IN ('pending', 'completed')")
@Index('uq_files_key', ['key'], { unique: true })
@Index('idx_files_pending_created_at', ['createdAt'], {
  where: "status = 'pending'",
})
export class StoredFile {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ type: 'text' })
  key: string;

  @Column({ name: 'owner_id', type: 'bigint' })
  ownerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'owner_id' })
  owner: Relation<User>;

  @Column({ name: 'content_type', type: 'text' })
  contentType: string;

  @Column({ type: 'bigint' })
  size: string;

  @Column({ type: 'text' })
  status: FileStatus;

  @Column({ name: 'upload_id', type: 'text', nullable: true })
  uploadId: string | null;

  @Column({ type: 'text', nullable: true })
  etag: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;
}
