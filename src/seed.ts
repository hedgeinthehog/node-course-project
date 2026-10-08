import dataSource from './data-source';
import { seedDatabase } from './seed-data';

async function main() {
  await dataSource.initialize();
  await seedDatabase(dataSource);
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
