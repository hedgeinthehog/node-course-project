import { DataSource } from 'typeorm';
import { checkout } from '../checkout/checkout';
import { IdempotencyStore, IdempotentResult } from '../common/idempotency';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderDto, toOrderDto } from './dto/order.dto';

export function placeOrder(
  dataSource: DataSource,
  key: string,
  dto: CreateOrderDto,
): Promise<IdempotentResult<OrderDto>> {
  return new IdempotencyStore(dataSource).run(key, dto, async (manager) =>
    toOrderDto(
      await checkout(manager, {
        userId: String(dto.user_id),
        items: dto.items.map((item) => ({
          productId: String(item.product_id),
          quantity: item.quantity,
        })),
      }),
    ),
  );
}
