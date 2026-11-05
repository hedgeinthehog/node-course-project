import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('access_denylist')
export class AccessDenylistEntry {
  @PrimaryColumn({ type: 'uuid' })
  jti: string;

  @Index('idx_access_denylist_expires_at')
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
}
