import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import { getOrder } from './orders-client.mjs';

const { integer, string, eachLike, regex, timestamp } = MatchersV3;

const provider = new PactV3({
  consumer: 'marketplace-web',
  provider: 'marketplace-api',
  dir: 'pacts',
});

test('GET /orders/{id} returns an existing order', async () => {
  provider
    .given('order 1 exists')
    .uponReceiving('a request for order 1')
    .withRequest({
      method: 'GET',
      path: '/orders/1',
      headers: { Accept: 'application/json' },
    })
    .willRespondWith({
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: {
        id: integer(1),
        items: eachLike({ product_id: integer(1), quantity: integer(2) }),
        total_cents: integer(519800),
        status: regex('pending|paid|cancelled', 'pending'),
        created_at: timestamp(
          "yyyy-MM-dd'T'HH:mm:ss.SSSX",
          '2026-09-02T09:49:29.909Z',
        ),
      },
    });

  await provider.executeTest(async (mockServer) => {
    const order = await getOrder(mockServer.url, 1);
    assert.equal(order.id, 1);
    assert.equal(order.total_cents, 519800);
    assert.equal(order.status, 'pending');
    assert.equal(order.items.length, 1);
  });
});
