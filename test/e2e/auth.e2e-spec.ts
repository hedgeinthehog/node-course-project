import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../../src/entities/refresh-token.entity';
import { given, TEST_PASSWORD } from '../integration/testkit/builders';
import { resetDatabase } from '../integration/testkit/database';
import { bearer, Tokens, tokensFor } from './auth-helpers';
import { createApp } from './create-app';

const forge = (token: string, role: string) => {
  const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  payload.role = role;
  parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return parts.join('.');
};

describe('auth (e2e)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  const api = () => request(app.getHttpServer());
  const refresh = (tokens: Tokens) =>
    api().post('/auth/refresh').send({ refresh_token: tokens.refresh_token });
  const withAccess = (tokens: Tokens) =>
    api().get('/orders').set('Authorization', `Bearer ${tokens.access_token}`);

  beforeAll(async () => {
    app = await createApp();
    dataSource = app.get(DataSource);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDatabase(dataSource));

  it('logs in with a password, rejects wrong credentials and anonymous access with 401', async () => {
    const buyer = await given(dataSource).user();

    const tokens = await tokensFor(app, buyer);
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 600 });
    expect(tokens.access_token.split('.')).toHaveLength(3);
    const header = JSON.parse(
      Buffer.from(tokens.access_token.split('.')[0], 'base64url').toString(),
    );
    expect(header).toMatchObject({ alg: 'ES256', kid: 'test' });

    await api()
      .post('/auth/login')
      .send({ email: buyer.email, password: 'wrong' })
      .expect(401);
    const anonymous = await api().get('/orders').expect(401);
    expect(anonymous.body).toMatchObject({
      status: 401,
      title: 'Unauthorized',
      detail: 'missing bearer token',
    });
    await api()
      .get('/orders')
      .set('Authorization', 'Bearer not-a-token')
      .expect(401);
  });

  it('logout revokes the refresh family and denies the access token until it expires', async () => {
    const buyer = await given(dataSource).user();
    const first = await tokensFor(app, buyer);
    const second = (await refresh(first).expect(200)).body as Tokens;
    await withAccess(second).expect(200);

    await api()
      .post('/auth/logout')
      .set('Authorization', `Bearer ${second.access_token}`)
      .expect(204);

    await withAccess(second).expect(401);
    await withAccess(first).expect(401);
    await refresh(second).expect(401);
    await expect(
      dataSource.query(`SELECT count(*)::int AS n FROM access_denylist`),
    ).resolves.toEqual([{ n: 1 }]);
    await tokensFor(app, buyer);
  });

  it('detects refresh-token reuse and kills the whole family, honest client included', async () => {
    const buyer = await given(dataSource).user();
    const r0 = await tokensFor(app, buyer);

    const r1 = (await refresh(r0).expect(200)).body as Tokens;
    await refresh(r0).expect(401);
    await refresh(r1).expect(401);
    await withAccess(r1).expect(401);

    const rows = await dataSource.getRepository(RefreshToken).find();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    expect(rows.every((r) => !r.tokenHash.includes(r0.refresh_token))).toBe(
      true,
    );
  });

  it('separates 401 from 403: ownership, role and a tampered signature', async () => {
    const { user, product, order } = given(dataSource);
    const owner = await user();
    const stranger = await user();
    const seller = await user({ role: 'seller' });
    const placed = await order(undefined, { userId: owner.id });
    await product({ sellerId: seller.id });
    const asOwner = await bearer(app, owner);
    const asStranger = await bearer(app, stranger);
    const asSeller = await bearer(app, seller);

    await api().get(`/orders/${placed.id}`).expect(401);
    await api().get(`/orders/${placed.id}`).set(asOwner).expect(200);
    const foreign = await api()
      .get(`/orders/${placed.id}`)
      .set(asStranger)
      .expect(403);
    expect(foreign.body).toMatchObject({ status: 403, title: 'Forbidden' });

    const newProduct = (sellerId: string) => ({
      seller_id: Number(sellerId),
      name: 'Lamp',
      price_cents: 1000,
      stock: 1,
    });
    await api()
      .post('/products')
      .set(asStranger)
      .set('Idempotency-Key', 'p-denied')
      .send(newProduct(stranger.id))
      .expect(403);
    await api()
      .post('/products')
      .set(asSeller)
      .set('Idempotency-Key', 'p-foreign')
      .send(newProduct(stranger.id))
      .expect(403);
    await api()
      .post('/products')
      .set(asSeller)
      .set('Idempotency-Key', 'p-allowed')
      .send(newProduct(seller.id))
      .expect(201);
    await api()
      .post('/orders')
      .set(asStranger)
      .set('Idempotency-Key', 'o-foreign')
      .send({
        user_id: Number(owner.id),
        items: [{ product_id: 1, quantity: 1 }],
      })
      .expect(403);

    const strangerToken = asStranger.Authorization.slice('Bearer '.length);
    await api()
      .get(`/orders/${placed.id}`)
      .set('Authorization', `Bearer ${forge(strangerToken, 'admin')}`)
      .expect(401);
  });

  it("lists only the caller's orders unless the caller is an admin", async () => {
    const { user, order } = given(dataSource);
    const alice = await user();
    const bob = await user();
    const admin = await user({ role: 'admin' });
    await order(undefined, { userId: alice.id });
    await order(undefined, { userId: bob.id });

    const asAlice = await bearer(app, alice);
    const asAdmin = await bearer(app, admin);
    const mine = await api().get('/orders').set(asAlice).expect(200);
    const all = await api().get('/orders').set(asAdmin).expect(200);

    expect(mine.body.items.map((o: { user_id: number }) => o.user_id)).toEqual([
      Number(alice.id),
    ]);
    expect(all.body.items).toHaveLength(2);
    expect(TEST_PASSWORD).toBe('password');
  });
});
