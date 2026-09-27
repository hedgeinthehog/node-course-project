import { DataSource, Logger } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { OrderItem } from './entities/order-item.entity';
import { Order } from './entities/order.entity';
import { Product } from './entities/product.entity';

class QueryCountLogger implements Logger {
  count = 0;
  logQuery() {
    this.count++;
  }
  logQueryError() {}
  logQuerySlow() {}
  logSchemaBuild() {}
  logMigration() {}
  log() {}
}

async function main() {
  const logger = new QueryCountLogger();
  const dataSource = new DataSource({
    ...dataSourceOptions,
    logging: ['query'],
    logger,
  });
  await dataSource.initialize();
  const orders = dataSource.getRepository(Order);

  async function measure(run: () => Promise<unknown>) {
    logger.count = 0;
    await run();
    return logger.count;
  }

  const sizes = process.argv
    .slice(2)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (sizes.length === 0) sizes.push(5, 10);

  const rows = [];
  for (const take of sizes) {
    let fetched = 0;
    const naive = await measure(async () => {
      const list = await orders.find({ order: { id: 'ASC' }, take });
      fetched = list.length;
      for (const order of list) {
        const items = await dataSource
          .getRepository(OrderItem)
          .findBy({ orderId: order.id });
        for (const item of items) {
          await dataSource
            .getRepository(Product)
            .findOneBy({ id: item.productId });
        }
      }
    });
    const joined = await measure(() =>
      orders.find({
        order: { id: 'ASC' },
        take,
        relations: { items: { product: true } },
      }),
    );
    const queryStrategy = await measure(() =>
      orders.find({
        order: { id: 'ASC' },
        take,
        relations: { items: { product: true } },
        relationLoadStrategy: 'query',
      }),
    );
    rows.push({
      take: take,
      'orders fetched (N)': fetched,
      'naive loop': naive,
      'relations (join)': joined,
      "relationLoadStrategy: 'query'": queryStrategy,
    });
  }
  console.log('SQL queries for "orders -> items -> product":');
  console.table(rows);
  await dataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
