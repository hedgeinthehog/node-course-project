import { DataSource } from 'typeorm';
import { checkout, CheckoutError } from '../../src/checkout/checkout';
import { Order } from '../../src/entities/order.entity';
import { Product } from '../../src/entities/product.entity';
import { Task } from '../../src/entities/task.entity';
import { User } from '../../src/entities/user.entity';
import { given } from './testkit/builders';
import { connect, resetDatabase } from './testkit/database';

describe('checkout', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await connect();
  });
  afterAll(() => dataSource.destroy());
  beforeEach(() => resetDatabase(dataSource));

  const stockOf = async (id: string) =>
    (await dataSource.getRepository(Product).findOneByOrFail({ id })).stock;
  const balanceOf = async (id: string) =>
    (await dataSource.getRepository(User).findOneByOrFail({ id })).balanceCents;

  it('decrements stock, charges the buyer and stores the order with a task', async () => {
    const { user, product } = given(dataSource);
    const buyer = await user({ balanceCents: '50000' });
    const keyboard = await product({ priceCents: 12_000, stock: 5 });

    const order = await checkout(dataSource, {
      userId: buyer.id,
      items: [{ productId: keyboard.id, quantity: 2 }],
    });

    expect(order).toMatchObject({ status: 'paid', totalCents: '24000' });
    await expect(stockOf(keyboard.id)).resolves.toBe(3);
    await expect(balanceOf(buyer.id)).resolves.toBe('26000');
    await expect(
      dataSource.getRepository(Task).findOneByOrFail({ status: 'pending' }),
    ).resolves.toMatchObject({
      type: 'order_confirmation',
      payload: { order_id: Number(order.id) },
    });
  });

  it('rolls back the reserved stock when the balance does not cover the total', async () => {
    const { user, product } = given(dataSource);
    const buyer = await user({ balanceCents: '100' });
    const keyboard = await product({ priceCents: 12_000, stock: 5 });

    const attempt = checkout(dataSource, {
      userId: buyer.id,
      items: [{ productId: keyboard.id, quantity: 1 }],
    });

    await expect(attempt).rejects.toMatchObject({
      name: 'CheckoutError',
      code: 'INSUFFICIENT_FUNDS',
    });
    await expect(stockOf(keyboard.id)).resolves.toBe(5);
    await expect(balanceOf(buyer.id)).resolves.toBe('100');
    await expect(dataSource.getRepository(Order).count()).resolves.toBe(0);
    await expect(dataSource.getRepository(Task).count()).resolves.toBe(0);
  });

  it('rolls back the first item when the second one is out of stock', async () => {
    const { user, product } = given(dataSource);
    const buyer = await user();
    const keyboard = await product({ stock: 5 });
    const mouse = await product({ stock: 0 });

    const attempt = checkout(dataSource, {
      userId: buyer.id,
      items: [
        { productId: keyboard.id, quantity: 1 },
        { productId: mouse.id, quantity: 1 },
      ],
    });

    await expect(attempt).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
    });
    await expect(stockOf(keyboard.id)).resolves.toBe(5);
    await expect(dataSource.getRepository(Order).count()).resolves.toBe(0);
  });

  it('never oversells when 20 checkouts race for 5 units', async () => {
    const { user, product } = given(dataSource);
    const buyer = await user();
    const keyboard = await product({ stock: 5 });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        checkout(dataSource, {
          userId: buyer.id,
          items: [{ productId: keyboard.id, quantity: 1 }],
        }),
      ),
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(
      rejected.every(
        (r) =>
          r.reason instanceof CheckoutError &&
          r.reason.code === 'INSUFFICIENT_STOCK',
      ),
    ).toBe(true);
    await expect(stockOf(keyboard.id)).resolves.toBe(0);
    await expect(dataSource.getRepository(Order).count()).resolves.toBe(5);
  });
});
