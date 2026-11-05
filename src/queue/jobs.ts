import { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import {
  loadProductCard,
  PRODUCT_CARD_TTL,
  productCardKey,
} from '../products/product-card';
import { CacheAside } from '../redis/cache-aside';
import { JOBS } from './queue';

export interface JobDeps {
  dataSource: DataSource;
  cache: CacheAside;
  log: (message: string) => void;
}

export const REFRESH_BATCH = 20;

export async function processJob(job: Job, deps: JobDeps): Promise<unknown> {
  switch (job.name) {
    case JOBS.confirmation: {
      const { orderId, eventId } = job.data as {
        orderId: number;
        eventId: string;
      };
      deps.log(`order ${orderId}: confirmation sent for event ${eventId}`);
      return { orderId };
    }
    case JOBS.refresh: {
      const ids: { id: string }[] = await deps.dataSource.query(
        `SELECT id FROM products WHERE status = 'active' ORDER BY created_at DESC LIMIT $1`,
        [REFRESH_BATCH],
      );
      for (const { id } of ids) {
        await deps.cache.invalidate(productCardKey(id));
        await deps.cache.getOrLoad(
          productCardKey(id),
          () => loadProductCard(deps.dataSource, id),
          PRODUCT_CARD_TTL,
        );
      }
      return { refreshed: ids.length };
    }
    case JOBS.flaky: {
      const failTimes = Number(
        (job.data as { failTimes?: number }).failTimes ?? 0,
      );
      if (job.attemptsMade < failTimes) {
        throw new Error(`simulated failure on attempt ${job.attemptsMade + 1}`);
      }
      return { attempts: job.attemptsMade + 1 };
    }
    default:
      throw new Error(`unknown job ${job.name}`);
  }
}
