import { DataSource, Repository } from 'typeorm';
import { OrderItem } from '../../src/entities/order-item.entity';
import { Order } from '../../src/entities/order.entity';
import { Product } from '../../src/entities/product.entity';
import { sellerRevenue } from '../../src/reports/seller-revenue';
import { given } from './testkit/builders';
import { connect, pgError, resetDatabase } from './testkit/database';

describe('orders repository', () => {
  let dataSource: DataSource;
  let orders: Repository<Order>;
  let items: Repository<OrderItem>;

  beforeAll(async () => {
    dataSource = await connect();
    orders = dataSource.getRepository(Order);
    items = dataSource.getRepository(OrderItem);
  });
  afterAll(() => dataSource.destroy());
  beforeEach(() => resetDatabase(dataSource));

  it('loads an order with its items and products through JOINs', async () => {
    const { product, order } = given(dataSource);
    const keyboard = await product({ name: 'Keyboard', priceCents: 5_000 });
    const mouse = await product({ name: 'Mouse', priceCents: 2_000 });
    const placed = await order([
      { product: keyboard, quantity: 2 },
      { product: mouse },
    ]);

    const loaded = await orders.findOneOrFail({
      where: { id: placed.id },
      relations: { items: { product: true } },
      order: { items: { id: 'ASC' } },
    });

    expect(loaded.totalCents).toBe('12000');
    expect(
      loaded.items.map((item) => [item.product.name, item.quantity]),
    ).toEqual([
      ['Keyboard', 2],
      ['Mouse', 1],
    ]);
  });

  it('deleting an order cascades to its items and keeps the products', async () => {
    const { product, order } = given(dataSource);
    const placed = await order([{ product: await product() }]);

    await orders.delete(placed.id);

    await expect(items.count()).resolves.toBe(0);
    await expect(dataSource.getRepository(Product).count()).resolves.toBe(1);
  });

  it('rejects the same product twice in one order (unique order_id + product_id)', async () => {
    const { product, order } = given(dataSource);
    const keyboard = await product();
    const placed = await order([{ product: keyboard }]);

    const duplicate = items.save(
      items.create({
        orderId: placed.id,
        productId: keyboard.id,
        quantity: 1,
        unitPriceCents: keyboard.priceCents,
      }),
    );

    await expect(duplicate).rejects.toMatchObject(pgError('23505'));
  });

  it('refuses to delete a product that has been ordered (foreign key RESTRICT)', async () => {
    const { product, order } = given(dataSource);
    const keyboard = await product();
    await order([{ product: keyboard }]);

    await expect(
      dataSource.getRepository(Product).delete(keyboard.id),
    ).rejects.toMatchObject(pgError('23503'));
  });

  it('aggregates revenue of paid orders per seller (JOIN + GROUP BY)', async () => {
    const { user, product, order } = given(dataSource);
    const alice = await user({ name: 'Alice' });
    const bob = await user({ name: 'Bob' });
    const keyboard = await product({ sellerId: alice.id, priceCents: 5_000 });
    const mouse = await product({ sellerId: alice.id, priceCents: 2_000 });
    const lamp = await product({ sellerId: bob.id, priceCents: 3_000 });
    await order([
      { product: keyboard, quantity: 2 },
      { product: lamp, quantity: 1 },
    ]);
    await order([{ product: mouse, quantity: 3 }]);
    await order([{ product: lamp, quantity: 10 }], { status: 'pending' });

    const report = await sellerRevenue(dataSource);

    expect(report).toEqual([
      expect.objectContaining({
        seller_name: 'Alice',
        orders_count: '2',
        units_sold: '5',
        revenue_cents: '16000',
      }),
      expect.objectContaining({
        seller_name: 'Bob',
        orders_count: '1',
        units_sold: '1',
        revenue_cents: '3000',
      }),
    ]);
  });
});
