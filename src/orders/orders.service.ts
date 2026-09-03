import { Injectable, NotFoundException } from '@nestjs/common';
import { IdempotencyStore } from '../common/idempotency';
import { Page, paginate } from '../common/pagination';
import { ProductsService } from '../products/products.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { Order } from './entities/order.entity';

@Injectable()
export class OrdersService {
  private readonly orders: Order[] = [];
  private nextId = 1;
  private readonly idempotency = new IdempotencyStore<Order>();

  constructor(private readonly productsService: ProductsService) {}

  create(key: string, dto: CreateOrderDto) {
    return this.idempotency.run(key, dto, () => {
      const total_cents = dto.items.reduce(
        (sum, item) =>
          sum +
          this.productsService.findOne(item.product_id).price_cents *
            item.quantity,
        0,
      );
      const order: Order = {
        id: this.nextId++,
        items: dto.items,
        total_cents,
        status: 'pending',
        created_at: new Date().toISOString(),
      };
      this.orders.push(order);
      return order;
    });
  }

  findAll(limit: number, cursor?: string): Page<Order> {
    return paginate(this.orders, limit, cursor);
  }

  findOne(id: number): Order {
    const order = this.orders.find((o) => o.id === id);
    if (!order) {
      throw new NotFoundException(`Order ${id} not found`);
    }
    return order;
  }
}
