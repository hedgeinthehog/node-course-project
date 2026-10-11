import dataSource from './data-source';
import { sellerRevenue } from './reports/seller-revenue';

async function main() {
  await dataSource.initialize();
  const rows = await sellerRevenue(dataSource);

  console.log('Revenue by seller (paid orders):');
  console.table(
    rows.map((row) => ({
      seller: row.seller_name,
      orders: Number(row.orders_count),
      units: Number(row.units_sold),
      revenue_cents: BigInt(row.revenue_cents).toString(),
    })),
  );
  await dataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
