import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { OrderItem } from '../../../src/entities/order-item.entity';
import { Order } from '../../../src/entities/order.entity';
import { Product } from '../../../src/entities/product.entity';
import { User } from '../../../src/entities/user.entity';

let sequence = 0;

export function aUser(overrides: Partial<User> = {}): Partial<User> {
  const n = ++sequence;
  return {
    email: `user-${n}-${randomUUID()}@example.com`,
    name: `User ${n}`,
    balanceCents: '1000000',
    ...overrides,
  };
}

export function aProduct(overrides: Partial<Product> = {}): Partial<Product> {
  const n = ++sequence;
  return {
    name: `Product ${n}`,
    description: `Description of product ${n}`,
    priceCents: 10_000,
    stock: 10,
    status: 'active',
    ...overrides,
  };
}

export interface OrderLine {
  product: Product;
  quantity?: number;
}

export function anOrder(
  lines: OrderLine[],
  overrides: Partial<Order> = {},
): Partial<Order> {
  const total = lines.reduce(
    (sum, line) => sum + (line.quantity ?? 1) * line.product.priceCents,
    0,
  );
  return { status: 'paid', totalCents: String(total), ...overrides };
}

export function given(dataSource: DataSource) {
  const users = dataSource.getRepository(User);
  const products = dataSource.getRepository(Product);
  const orders = dataSource.getRepository(Order);
  const items = dataSource.getRepository(OrderItem);

  const user = (overrides: Partial<User> = {}) =>
    users.save(users.create(aUser(overrides)));

  const product = async (overrides: Partial<Product> = {}) =>
    products.save(
      products.create(
        aProduct({
          sellerId: overrides.sellerId ?? (await user()).id,
          ...overrides,
        }),
      ),
    );

  const order = async (
    lines?: OrderLine[],
    overrides: Partial<Order> = {},
  ): Promise<Order> => {
    const orderLines = lines ?? [{ product: await product() }];
    const saved = await orders.save(
      orders.create(
        anOrder(orderLines, {
          userId: overrides.userId ?? (await user()).id,
          ...overrides,
        }),
      ),
    );
    saved.items = await items.save(
      orderLines.map((line) =>
        items.create({
          orderId: saved.id,
          productId: line.product.id,
          quantity: line.quantity ?? 1,
          unitPriceCents: line.product.priceCents,
        }),
      ),
    );
    return saved;
  };

  return { user, product, order };
}
