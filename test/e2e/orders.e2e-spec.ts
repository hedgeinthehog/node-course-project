import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { given } from '../integration/testkit/builders';
import { resetDatabase } from '../integration/testkit/database';
import { createApp } from './create-app';

describe('orders API (e2e)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createApp();
    dataSource = app.get(DataSource);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDatabase(dataSource));

  it('creates a product, places an order and reads both back', async () => {
    const { user } = given(dataSource);
    const seller = await user();
    const buyer = await user({ balanceCents: '100000' });

    const product = await api()
      .post('/products')
      .set('Idempotency-Key', 'product-1')
      .send({
        seller_id: Number(seller.id),
        name: 'Keyboard',
        price_cents: 25_000,
        stock: 3,
      })
      .expect(201);
    expect(product.body).toEqual({
      id: expect.any(Number),
      name: 'Keyboard',
      price_cents: 25_000,
      stock: 3,
    });

    const orderRequest = {
      user_id: Number(buyer.id),
      items: [{ product_id: product.body.id, quantity: 2 }],
    };
    const placed = await api()
      .post('/orders')
      .set('Idempotency-Key', 'order-1')
      .send(orderRequest)
      .expect(201);
    expect(placed.body).toMatchObject({
      user_id: Number(buyer.id),
      items: [{ product_id: product.body.id, quantity: 2 }],
      total_cents: 50_000,
      status: 'paid',
    });

    const fetched = await api().get(`/orders/${placed.body.id}`).expect(200);
    expect(fetched.body).toEqual(placed.body);

    const stock = await api().get(`/products/${product.body.id}`).expect(200);
    expect(stock.body.stock).toBe(1);

    const replay = await api()
      .post('/orders')
      .set('Idempotency-Key', 'order-1')
      .send(orderRequest)
      .expect(201);
    expect(replay.headers['idempotency-replay']).toBe('true');
    expect(replay.body).toEqual(placed.body);
    const list = await api().get('/orders').expect(200);
    expect(list.body.items).toHaveLength(1);
  });

  it('rejects an order without Idempotency-Key with 400 problem+json', async () => {
    const response = await api()
      .post('/orders')
      .send({ user_id: 1, items: [{ product_id: 1, quantity: 1 }] })
      .expect(400);

    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.body).toMatchObject({
      status: 400,
      title: 'Bad Request',
      detail: expect.stringContaining('idempotency-key'),
      instance: '/orders',
    });
  });

  it('returns 404 problem+json for an order that does not exist', async () => {
    const response = await api().get('/orders/424242').expect(404);

    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.body).toMatchObject({
      status: 404,
      detail: 'Order 424242 not found',
    });
  });

  it('answers 409 and keeps the stock when the order asks for more than is left', async () => {
    const { user, product } = given(dataSource);
    const buyer = await user();
    const lamp = await product({ stock: 1 });

    const response = await api()
      .post('/orders')
      .set('Idempotency-Key', 'order-2')
      .send({
        user_id: Number(buyer.id),
        items: [{ product_id: Number(lamp.id), quantity: 2 }],
      })
      .expect(409);

    expect(response.body.detail).toContain('not enough stock');
    const stock = await api().get(`/products/${lamp.id}`).expect(200);
    expect(stock.body.stock).toBe(1);
  });
});
