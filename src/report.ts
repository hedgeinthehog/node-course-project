import dataSource from './data-source';
import { OrderItem } from './entities/order-item.entity';

interface SellerRevenueRow {
  seller_id: string;
  seller_name: string;
  orders_count: string;
  units_sold: string;
  revenue_cents: string;
}

async function main() {
  await dataSource.initialize();
  const rows = await dataSource
    .getRepository(OrderItem)
    .createQueryBuilder('item')
    .innerJoin('item.order', 'o')
    .innerJoin('item.product', 'product')
    .innerJoin('product.seller', 'seller')
    .select('seller.id', 'seller_id')
    .addSelect('seller.name', 'seller_name')
    .addSelect('COUNT(DISTINCT o.id)', 'orders_count')
    .addSelect('SUM(item.quantity)', 'units_sold')
    .addSelect('SUM(item.quantity * item.unit_price_cents)', 'revenue_cents')
    .where('o.status = :status', { status: 'paid' })
    .groupBy('seller.id')
    .addGroupBy('seller.name')
    .orderBy('revenue_cents', 'DESC')
    .getRawMany<SellerRevenueRow>();

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
