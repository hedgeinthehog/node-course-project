import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

export const SESSION_TTL_S = 1800;

export interface Session {
  id: string;
  userId: number;
  createdAt: string;
  expiresIn: number;
}

export class SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSec = SESSION_TTL_S,
  ) {}

  static key(id: string) {
    return `session:${id}`;
  }

  async create(userId: number): Promise<Session> {
    const session = {
      id: randomUUID(),
      userId,
      createdAt: new Date().toISOString(),
    };
    await this.redis.set(
      SessionStore.key(session.id),
      JSON.stringify(session),
      'EX',
      this.ttlSec,
    );
    return { ...session, expiresIn: this.ttlSec };
  }

  async touch(id: string): Promise<Session | null> {
    const raw = await this.redis.getex(SessionStore.key(id), 'EX', this.ttlSec);
    return raw === null
      ? null
      : {
          ...(JSON.parse(raw) as Omit<Session, 'expiresIn'>),
          expiresIn: this.ttlSec,
        };
  }

  ttl(id: string): Promise<number> {
    return this.redis.ttl(SessionStore.key(id));
  }

  async destroy(id: string): Promise<boolean> {
    return (await this.redis.del(SessionStore.key(id))) === 1;
  }
}
