import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('access_denylist')
export class AccessDenylistEntry {
  @PrimaryColumn({ type: 'uuid' })
  jti: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
}
