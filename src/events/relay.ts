import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DomainEvent } from './order-placed';
import { EventPublisher } from './publisher';

export const RELAY_BATCH = 100;
export const RELAY_INTERVAL_MS = 1000;

export interface OutboxRow {
  id: string;
  type: string;
  payload: DomainEvent<string, unknown>;
  attempts: number;
}

export interface RelayOptions {
  batch?: number;
  intervalMs?: number;
  afterPublish?: (row: OutboxRow) => void | Promise<void>;
  afterPoll?: (run: RelayRun) => void | Promise<void>;
  onError?: (message: string) => void;
}

export interface RelayRun {
  published: number;
  failed: number;
}

export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dataSource: DataSource,
    private readonly publisher: EventPublisher,
    private readonly options: RelayOptions = {},
  ) {}

  onModuleInit() {
    this.start();
  }

  onModuleDestroy() {
    return this.stop();
  }

  runOnce(): Promise<RelayRun> {
    return this.dataSource.transaction(async (manager) => {
      const rows: OutboxRow[] = await manager.query(
        `SELECT id, type, payload, attempts FROM outbox
         WHERE published_at IS NULL
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [this.options.batch ?? RELAY_BATCH],
      );
      const run: RelayRun = { published: 0, failed: 0 };
      for (const row of rows) {
        try {
          await this.publisher.publish(row.payload);
        } catch (err) {
          run.failed++;
          this.options.onError?.(
            `outbox ${row.id}: publish failed, ${(err as Error).message}`,
          );
          await manager.query(
            `UPDATE outbox SET attempts = attempts + 1 WHERE id = $1`,
            [row.id],
          );
          continue;
        }
        await this.options.afterPublish?.(row);
        await manager.query(
          `UPDATE outbox SET published_at = now(), attempts = attempts + 1 WHERE id = $1`,
          [row.id],
        );
        run.published++;
      }
      return run;
    });
  }

  start(): void {
    if (this.timer) return;
    const tick = () => {
      this.current = this.runOnce()
        .then((run) => this.options.afterPoll?.(run))
        .catch((err: Error) => this.options.onError?.(`relay: ${err.message}`));
      void this.current.then(() => {
        if (this.timer) {
          this.timer = setTimeout(
            tick,
            this.options.intervalMs ?? RELAY_INTERVAL_MS,
          );
        }
      });
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    await this.current;
  }
}
