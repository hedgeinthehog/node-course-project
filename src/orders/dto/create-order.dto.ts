import { OrderItem } from '../entities/order.entity';

export interface CreateOrderDto {
  items: OrderItem[];
}
