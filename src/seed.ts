import dataSource from './data-source';
import { OrderItem } from './entities/order-item.entity';
import { Order } from './entities/order.entity';
import { Product } from './entities/product.entity';
import { User } from './entities/user.entity';

const PRODUCT_NAMES = [
  'Шкіряні кросівки',
  'Бавовняна футболка',
  'Ігровий ноутбук',
  'Туристичний рюкзак',
  'Бездротові навушники',
  'Зимова куртка',
  'Офісне крісло',
  'Розумний годинник',
  'Класичні джинси',
  'Настільна лампа',
  'Спортивна сумка',
  'Механічна клавіатура',
];
const STATUSES = ['paid', 'paid', 'paid', 'pending', 'cancelled'] as const;

async function main() {
  await dataSource.initialize();
  await dataSource.transaction(async (manager) => {
    const users = Array.from({ length: 10 }, (_, i) => ({
      id: String(i + 1),
      email: `seed.user${i + 1}@example.com`,
      name: `Користувач ${i + 1}`,
    }));
    await manager.upsert(User, users, ['id']);

    const products = PRODUCT_NAMES.map((name, i) => ({
      id: String(i + 1),
      sellerId: String((i % 3) + 1),
      name,
      description: `${name} для щоденного використання`,
      priceCents: 19900 + i * 15000,
      status: 'active' as const,
    }));
    await manager.upsert(Product, products, ['id']);

    const items = Array.from({ length: 10 }, (_, o) =>
      Array.from({ length: (o % 3) + 1 }, (_, k) => {
        const product = products[(o + k * 5) % products.length];
        return {
          orderId: String(o + 1),
          productId: product.id,
          quantity: ((o + k) % 3) + 1,
          unitPriceCents: product.priceCents,
        };
      }),
    );
    const orders = items.map((orderItems, o) => ({
      id: String(o + 1),
      userId: String(((o * 3) % 10) + 1),
      status: STATUSES[o % STATUSES.length],
      totalCents: String(
        orderItems.reduce((sum, i) => sum + i.quantity * i.unitPriceCents, 0),
      ),
      createdAt: new Date(Date.UTC(2026, 0, o + 1, 12)),
    }));
    await manager.upsert(Order, orders, ['id']);
    await manager.upsert(
      OrderItem,
      items.flat().map((item, i) => ({ id: String(i + 1), ...item })),
      ['id'],
    );

    for (const table of ['users', 'products', 'orders', 'order_items']) {
      await manager.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT max(id) FROM ${table}))`,
      );
    }
  });

  const counts = await dataSource.query(
    `SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM products) AS products,
            (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM order_items) AS order_items`,
  );
  console.log('seeded:', counts[0]);
  await dataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
