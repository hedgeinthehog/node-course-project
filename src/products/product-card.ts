import { DataSource, EntityManager } from 'typeorm';
import { ProductDto } from './dto/product.dto';

export interface ProductCardDto extends ProductDto {
  sold: number;
}

export const PRODUCT_CARD_TTL = { ttlSec: 300, jitterSec: 60 };

export const productCardKey = (id: number | string) => `product:${id}`;

export async function loadProductCard(
  db: DataSource | EntityManager,
  id: string,
): Promise<ProductCardDto | null> {
  const [row]: {
    id: string;
    name: string;
    price_cents: number;
    stock: number;
    sold: number;
  }[] = await db.query(
    `SELECT p.id, p.name, p.price_cents, p.stock,
            coalesce(sum(oi.quantity) FILTER (WHERE o.status <> 'cancelled'), 0)::int AS sold
     FROM products p
     LEFT JOIN order_items oi ON oi.product_id = p.id
     LEFT JOIN orders o ON o.id = oi.order_id
     WHERE p.id = $1
     GROUP BY p.id`,
    [id],
  );
  return row
    ? {
        id: Number(row.id),
        name: row.name,
        price_cents: row.price_cents,
        stock: row.stock,
        sold: row.sold,
      }
    : null;
}
