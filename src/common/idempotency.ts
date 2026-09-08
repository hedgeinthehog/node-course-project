import { createHash } from 'node:crypto';
import { UnprocessableEntityException } from '@nestjs/common';

interface Stored<T> {
  fingerprint: string;
  result: T;
}

export interface IdempotentResult<T> {
  result: T;
  replayed: boolean;
}

export class IdempotencyStore<T> {
  private readonly entries = new Map<string, Stored<T>>();

  run(key: string, body: unknown, create: () => T): IdempotentResult<T> {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex');
    const stored = this.entries.get(key);
    if (stored) {
      if (stored.fingerprint !== fingerprint) {
        throw new UnprocessableEntityException(
          'Idempotency-Key was already used with a different request body',
        );
      }
      return { result: stored.result, replayed: true };
    }
    const result = create();
    this.entries.set(key, { fingerprint, result });
    return { result, replayed: false };
  }
}
