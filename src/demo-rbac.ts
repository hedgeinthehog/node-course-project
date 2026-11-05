import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { call, forgeRole, login, newAccount } from './auth/demo-accounts';
import { dataSourceOptions } from './data-source';
import { finish, summary } from './events/demo-harness';
import { Product } from './entities/product.entity';
import { placeOrder } from './orders/place-order';
import { bootApi } from './redis/demo-api';

async function main() {
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const owner = await newAccount(dataSource, 'buyer');
  const stranger = await newAccount(dataSource, 'buyer');
  const seller = await newAccount(dataSource, 'seller');
  const products = dataSource.getRepository(Product);
  const product = await products.save(
    products.create({
      sellerId: String(seller.id),
      name: `Demo product ${randomUUID()}`,
      description: 'created by the rbac demo',
      priceCents: 1000,
      stock: 5,
    }),
  );
  const { result: order } = await placeOrder(
    dataSource,
    `rbac-${randomUUID()}`,
    {
      user_id: owner.id,
      items: [{ product_id: Number(product.id), quantity: 1 }],
    },
  );
  await dataSource.destroy();

  const api = await bootApi();
  const ownerToken = (await login(api.url, owner)).body.access_token as string;
  const strangerToken = (await login(api.url, stranger)).body
    .access_token as string;
  const sellerToken = (await login(api.url, seller)).body
    .access_token as string;
  const newProduct = (sellerId: number) => ({
    seller_id: sellerId,
    name: `Demo product ${randomUUID()}`,
    price_cents: 2500,
    stock: 1,
  });

  const anon = await call(api.url, 'GET', `/orders/${order.id}`);
  const own = await call(api.url, 'GET', `/orders/${order.id}`, {
    token: ownerToken,
  });
  const foreign = await call(api.url, 'GET', `/orders/${order.id}`, {
    token: strangerToken,
  });
  const roleDenied = await call(api.url, 'POST', '/products', {
    token: strangerToken,
    headers: { 'idempotency-key': randomUUID() },
    body: newProduct(stranger.id),
  });
  const roleAllowed = await call(api.url, 'POST', '/products', {
    token: sellerToken,
    headers: { 'idempotency-key': randomUUID() },
    body: newProduct(seller.id),
  });
  const sellerForeign = await call(api.url, 'POST', '/products', {
    token: sellerToken,
    headers: { 'idempotency-key': randomUUID() },
    body: newProduct(stranger.id),
  });
  const tampered = await call(api.url, 'GET', `/orders/${order.id}`, {
    token: forgeRole(strangerToken, 'admin'),
  });
  await api.close();

  summary({
    anon: anon.status,
    own: own.status,
    foreign: foreign.status,
    'role-denied': roleDenied.status,
    'role-allowed': roleAllowed.status,
    'seller-foreign': sellerForeign.status,
    tampered: tampered.status,
  });
  finish(
    anon.status === 401 &&
      own.status === 200 &&
      foreign.status === 403 &&
      roleDenied.status === 403 &&
      roleAllowed.status === 201 &&
      sellerForeign.status === 403 &&
      tampered.status === 401,
    '401 and 403 are separate: ownership and role are decided after the signature, never instead of it',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
