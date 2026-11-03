import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DomainEvent } from './order-placed';

export const RELAY_BATCH = 100;
export const RELAY_INTERVAL_MS = 1000;
export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_BACKOFF_BASE_S = 1;
export const OUTBOX_BACKOFF_MAX_S = 300;

export interface OutboxRow {
  id: string;
  type: string;
  payload: DomainEvent<string, unknown>;
  attempts: number;
}

export interface RelayPublisher {
  publish(event: DomainEvent<string, unknown>): Promise<void>;
  deadLetter(
    event: DomainEvent<string, unknown>,
    reason: string,
  ): Promise<void>;
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
  dead: number;
}

const BACKOFF_SQL = `now() + make_interval(secs => least(${OUTBOX_BACKOFF_BASE_S} * power(2, $2::int), ${OUTBOX_BACKOFF_MAX_S}))`;

export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dataSource: DataSource,
    private readonly publisher: RelayPublisher,
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
         WHERE published_at IS NULL AND failed_at IS NULL AND next_attempt_at <= now()
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [this.options.batch ?? RELAY_BATCH],
      );
      const run: RelayRun = { published: 0, failed: 0, dead: 0 };
      for (const row of rows) {
        try {
          await this.publisher.publish(row.payload);
        } catch (err) {
          const attempts = row.attempts + 1;
          const error = (err as Error).message;
          this.options.onError?.(
            `outbox ${row.id}: publish attempt ${attempts} failed, ${error}`,
          );
          if (
            attempts >= OUTBOX_MAX_ATTEMPTS &&
            (await this.bury(row, error))
          ) {
            await manager.query(
              `UPDATE outbox SET attempts = $2, last_error = $3, failed_at = now() WHERE id = $1`,
              [row.id, attempts, error],
            );
            run.dead++;
          } else {
            await manager.query(
              `UPDATE outbox SET attempts = $2::int, last_error = $3, next_attempt_at = ${BACKOFF_SQL} WHERE id = $1`,
              [row.id, attempts, error],
            );
            run.failed++;
          }
          continue;
        }
        await this.options.afterPublish?.(row);
        await manager.query(
          `UPDATE outbox SET published_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`,
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

  private async bury(row: OutboxRow, error: string): Promise<boolean> {
    try {
      await this.publisher.deadLetter(
        row.payload,
        `relay gave up after ${OUTBOX_MAX_ATTEMPTS} attempts: ${error}`,
      );
      return true;
    } catch (err) {
      this.options.onError?.(
        `outbox ${row.id}: dead-lettering failed too, ${(err as Error).message}`,
      );
      return false;
    }
  }
}
