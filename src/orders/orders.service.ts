import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, MoreThan, Repository } from 'typeorm';
import { IdempotencyStore } from '../common/idempotency';
import { buildPage, decodeCursor, Page } from '../common/pagination';
import { OrderItem } from '../entities/order-item.entity';
import { Order } from '../entities/order.entity';
import { Product } from '../entities/product.entity';
import { User } from '../entities/user.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderDto, toOrderDto } from './dto/order.dto';

@Injectable()
export class OrdersService {
  private readonly idempotency = new IdempotencyStore<OrderDto>();

  constructor(
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    private readonly dataSource: DataSource,
  ) {}

  create(key: string, dto: CreateOrderDto) {
    return this.idempotency.run(key, dto, () =>
      this.dataSource.transaction(async (manager) => {
        const userId = String(dto.user_id);
        if (!(await manager.existsBy(User, { id: userId }))) {
          throw new NotFoundException(`User ${dto.user_id} not found`);
        }

        const quantities = new Map<string, number>();
        for (const item of dto.items) {
          const productId = String(item.product_id);
          quantities.set(
            productId,
            (quantities.get(productId) ?? 0) + item.quantity,
          );
        }
        const products = await manager.findBy(Product, {
          id: In([...quantities.keys()]),
        });
        const byId = new Map(products.map((p) => [p.id, p]));
        for (const productId of quantities.keys()) {
          if (!byId.has(productId)) {
            throw new NotFoundException(`Product ${productId} not found`);
          }
        }

        const totalCents = [...quantities].reduce(
          (sum, [productId, quantity]) =>
            sum + byId.get(productId)!.priceCents * quantity,
          0,
        );
        const order = await manager.save(
          manager.create(Order, {
            userId,
            status: 'pending',
            totalCents: String(totalCents),
          }),
        );
        order.items = await manager.save(
          [...quantities].map(([productId, quantity]) =>
            manager.create(OrderItem, {
              orderId: order.id,
              productId,
              quantity,
              unitPriceCents: byId.get(productId)!.priceCents,
            }),
          ),
        );
        return toOrderDto(order);
      }),
    );
  }

  async findAll(limit: number, cursor?: string): Promise<Page<OrderDto>> {
    const rows = await this.orders.find({
      where: { id: MoreThan(String(decodeCursor(cursor))) },
      order: { id: 'ASC' },
      take: limit + 1,
      relations: { items: true },
    });
    return buildPage(rows.map(toOrderDto), limit);
  }

  async findOne(id: string): Promise<OrderDto> {
    const order = await this.orders.findOne({
      where: { id },
      relations: { items: true },
    });
    if (!order) {
      throw new NotFoundException(`Order ${id} not found`);
    }
    return toOrderDto(order);
  }
}
