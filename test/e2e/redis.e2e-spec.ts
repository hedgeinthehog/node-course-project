import { NestExpressApplication } from '@nestjs/platform-express';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { SessionStore } from '../../src/redis/session.store';
import { given } from '../integration/testkit/builders';
import { resetDatabase } from '../integration/testkit/database';
import { createApp } from './create-app';

describe('redis-backed API features (e2e)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let redis: Redis;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createApp();
    dataSource = app.get(DataSource);
    redis = new Redis(process.env.REDIS_URL!);
  });
  afterAll(async () => {
    await redis.quit();
    await app.close();
  });
  beforeEach(() => resetDatabase(dataSource));

  it('serves the product card from the cache and invalidates it when an order is placed', async () => {
    const { user, product } = given(dataSource);
    const buyer = await user();
    const lamp = await product({ stock: 5, priceCents: 1000 });

    const cold = await api().get(`/products/${lamp.id}`).expect(200);
    expect(cold.body).toEqual({
      id: Number(lamp.id),
      name: lamp.name,
      price_cents: 1000,
      stock: 5,
      sold: 0,
    });
    const ttl = await redis.ttl(`product:${lamp.id}`);
    expect(ttl).toBeGreaterThanOrEqual(295);
    expect(ttl).toBeLessThanOrEqual(360);

    await dataSource.query(`UPDATE products SET stock = 1 WHERE id = $1`, [
      lamp.id,
    ]);
    const stale = await api().get(`/products/${lamp.id}`).expect(200);
    expect(stale.body.stock).toBe(5);

    await api()
      .post('/orders')
      .set('Idempotency-Key', 'cache-1')
      .send({
        user_id: Number(buyer.id),
        items: [{ product_id: Number(lamp.id), quantity: 1 }],
      })
      .expect(201);
    const fresh = await api().get(`/products/${lamp.id}`).expect(200);
    expect(fresh.body).toMatchObject({ stock: 0, sold: 1 });
  });

  it('creates a session in Redis, renews it on every read and rejects unknown ids with 401', async () => {
    const { user } = given(dataSource);
    const buyer = await user();

    const created = await api()
      .post('/sessions')
      .send({ user_id: Number(buyer.id) })
      .expect(201);
    expect(created.body).toEqual({
      session_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      user_id: Number(buyer.id),
      expires_in: 1800,
    });
    const key = SessionStore.key(created.body.session_id);
    await redis.expire(key, 100);

    const me = await api()
      .get('/sessions/me')
      .set('X-Session-Id', created.body.session_id)
      .expect(200);
    expect(me.body).toEqual(created.body);
    expect(await redis.ttl(key)).toBeGreaterThan(1700);

    await redis.expire(key, 100);
    await api()
      .get('/products?limit=1')
      .set('X-Session-Id', created.body.session_id)
      .expect(200);
    expect(await redis.ttl(key)).toBeGreaterThan(1700);

    const unknown = await api()
      .get('/sessions/me')
      .set('X-Session-Id', '00000000-0000-4000-8000-000000000000')
      .expect(401);
    expect(unknown.body).toMatchObject({ status: 401, title: 'Unauthorized' });
    await api().post('/sessions').send({ user_id: 424242 }).expect(404);
  });

  it('answers 429 with Retry-After once a client exceeds the sliding-window limit', async () => {
    const limit = 100;
    let lastStatus = 200;
    for (let i = 0; i < limit; i++) {
      const response = await api().get('/products?limit=1');
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(200);

    const blocked = await api().get('/products?limit=1').expect(429);
    expect(blocked.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(blocked.body).toMatchObject({
      status: 429,
      title: 'Too Many Requests',
    });
    await api().get('/health').expect(200);
  });
});
