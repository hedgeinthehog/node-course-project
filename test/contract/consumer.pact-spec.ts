import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type * as Pact from '@pact-foundation/pact';
import { ApiError, OrdersClient } from './orders-client';

declare const nativeRequire: NodeJS.Require;
const { MatchersV3, PactV3 } = nativeRequire(
  '@pact-foundation/pact',
) as typeof Pact;
const { eachLike, integer, regex, string } = MatchersV3;

const PACT_DIR = 'pacts';
const CONSUMER = 'marketplace-web';
const PROVIDER = 'marketplace-api';

const json = regex('application/json.*', 'application/json; charset=utf-8');
const problemJson = regex(
  'application/problem\\+json.*',
  'application/problem+json; charset=utf-8',
);
const isoTimestamp = regex(
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
  '2026-01-01T12:00:00.000Z',
);

describe('marketplace-web expectations of marketplace-api', () => {
  const pact = new PactV3({
    consumer: CONSUMER,
    provider: PROVIDER,
    dir: PACT_DIR,
  });

  beforeAll(() => {
    rmSync(join(PACT_DIR, `${CONSUMER}-${PROVIDER}.json`), { force: true });
  });

  it('GET /orders/{id} returns an existing order', async () => {
    pact
      .given('order 1 exists')
      .uponReceiving('a request for order 1')
      .withRequest({
        method: 'GET',
        path: '/orders/1',
        headers: { Accept: 'application/json' },
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': json },
        body: {
          id: integer(1),
          user_id: integer(1),
          items: eachLike({ product_id: integer(1), quantity: integer(1) }),
          total_cents: integer(19900),
          status: regex('pending|paid|cancelled', 'paid'),
          created_at: isoTimestamp,
        },
      });

    await pact.executeTest(async (server) => {
      const order = await new OrdersClient(server.url).getOrder(1);

      expect(order.id).toBe(1);
      expect(order.items).toEqual([{ product_id: 1, quantity: 1 }]);
      expect(order.total_cents).toBe(19900);
    });
  });

  it('GET /orders/{id} answers 404 problem+json for a missing order', async () => {
    pact
      .given('order 999 does not exist')
      .uponReceiving('a request for order 999')
      .withRequest({
        method: 'GET',
        path: '/orders/999',
        headers: { Accept: 'application/json' },
      })
      .willRespondWith({
        status: 404,
        headers: { 'Content-Type': problemJson },
        body: {
          type: string('https://marketplace.example/problems/404'),
          title: string('Not Found'),
          status: integer(404),
          detail: string('Order 999 not found'),
          instance: string('/orders/999'),
        },
      });

    await pact.executeTest(async (server) => {
      const missing = new OrdersClient(server.url).getOrder(999);

      await expect(missing).rejects.toBeInstanceOf(ApiError);
      await expect(missing).rejects.toMatchObject({ problem: { status: 404 } });
    });
  });

  it('POST /orders places an order and returns it as paid', async () => {
    const request = { user_id: 1, items: [{ product_id: 2, quantity: 1 }] };
    pact
      .given('user 1 has funds and product 2 is in stock')
      .uponReceiving('a request to place an order')
      .withRequest({
        method: 'POST',
        path: '/orders',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': '6f1c0a52-7b1e-4d0e-9a39-2d6c1f0f8b11',
        },
        body: request,
      })
      .willRespondWith({
        status: 201,
        headers: { 'Content-Type': json },
        body: {
          id: integer(11),
          user_id: integer(1),
          items: [{ product_id: integer(2), quantity: integer(1) }],
          total_cents: integer(34900),
          status: 'paid',
          created_at: isoTimestamp,
        },
      });

    await pact.executeTest(async (server) => {
      const order = await new OrdersClient(server.url).placeOrder(
        '6f1c0a52-7b1e-4d0e-9a39-2d6c1f0f8b11',
        request,
      );

      expect(order.status).toBe('paid');
      expect(order.items).toEqual(request.items);
    });
  });
});
