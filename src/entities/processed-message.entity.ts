import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('processed_messages')
export class ProcessedMessage {
  @PrimaryColumn({ name: 'message_id', type: 'uuid' })
  messageId: string;

  @PrimaryColumn({ type: 'text' })
  consumer: string;

  @CreateDateColumn({ name: 'processed_at', type: 'timestamptz' })
  processedAt: Date;
}
