import { DataSource } from 'typeorm';
import { OrderItem } from '../entities/order-item.entity';

export interface SellerRevenueRow {
  seller_id: string;
  seller_name: string;
  orders_count: string;
  units_sold: string;
  revenue_cents: string;
}

export function sellerRevenue(dataSource: DataSource) {
  return dataSource
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
}
