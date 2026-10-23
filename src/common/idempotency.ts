import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

export interface IdempotentResult<T> {
  result: T;
  replayed: boolean;
}

export class IdempotencyKeyReuseError extends Error {
  constructor() {
    super('Idempotency-Key was already used with a different request body');
    this.name = 'IdempotencyKeyReuseError';
  }
}

export class IdempotencyStore {
  constructor(private readonly dataSource: DataSource) {}

  run<T>(
    key: string,
    body: unknown,
    create: (manager: EntityManager) => Promise<T>,
  ): Promise<IdempotentResult<T>> {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex');
    return this.dataSource.transaction(async (manager) => {
      const claimed: { key: string }[] = await manager.query(
        `INSERT INTO idempotency_keys (key, fingerprint) VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
        [key, fingerprint],
      );
      if (claimed.length === 0) {
        const [stored]: { fingerprint: string; result: T }[] =
          await manager.query(
            `SELECT fingerprint, result FROM idempotency_keys WHERE key = $1`,
            [key],
          );
        if (!stored || stored.fingerprint !== fingerprint) {
          throw new IdempotencyKeyReuseError();
        }
        return { result: stored.result, replayed: true };
      }
      const result = await create(manager);
      await manager.query(
        `UPDATE idempotency_keys SET result = $2 WHERE key = $1`,
        [key, JSON.stringify(result)],
      );
      return { result, replayed: false };
    });
  }
}
