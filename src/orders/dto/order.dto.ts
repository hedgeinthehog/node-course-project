import { Order } from '../../entities/order.entity';

export interface OrderDto {
  id: number;
  user_id: number;
  items: { product_id: number; quantity: number }[];
  total_cents: number;
  status: Order['status'];
  created_at: string;
}

export function toOrderDto(order: Order): OrderDto {
  return {
    id: Number(order.id),
    user_id: Number(order.userId),
    items: [...order.items]
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((item) => ({
        product_id: Number(item.productId),
        quantity: item.quantity,
      })),
    total_cents: Number(order.totalCents),
    status: order.status,
    created_at: order.createdAt.toISOString(),
  };
}
