import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, MoreThan, Repository } from 'typeorm';
import { checkout, CheckoutError } from '../checkout/checkout';
import { IdempotencyStore } from '../common/idempotency';
import { buildPage, decodeCursor, Page } from '../common/pagination';
import { OrderItem } from '../entities/order-item.entity';
import { Order } from '../entities/order.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderDto, toOrderDto } from './dto/order.dto';
import { OrderEventsService } from './order-events.service';
import { canTransition, OrderStatus } from './order-status';

@Injectable()
export class OrdersService {
  private readonly idempotency = new IdempotencyStore<OrderDto>();

  constructor(
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    private readonly dataSource: DataSource,
    private readonly events: OrderEventsService,
  ) {}

  create(key: string, dto: CreateOrderDto) {
    return this.idempotency.run(key, dto, async () => {
      try {
        const order = await checkout(this.dataSource, {
          userId: String(dto.user_id),
          items: dto.items.map((item) => ({
            productId: String(item.product_id),
            quantity: item.quantity,
          })),
        });
        return toOrderDto(order);
      } catch (err) {
        if (err instanceof CheckoutError) {
          throw err.code === 'USER_NOT_FOUND' ||
            err.code === 'PRODUCT_NOT_FOUND'
            ? new NotFoundException(err.message)
            : new ConflictException(err.message);
        }
        throw err;
      }
    });
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

  async changeStatus(id: string, next: OrderStatus): Promise<OrderDto> {
    const { order, previous } = await this.dataSource.transaction(
      async (manager) => {
        const order = await manager.findOne(Order, {
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!order) {
          throw new NotFoundException(`Order ${id} not found`);
        }
        if (!canTransition(order.status, next)) {
          throw new ConflictException(
            `Order ${id}: cannot change status from ${order.status} to ${next}`,
          );
        }
        const previous = order.status;
        await manager.update(Order, id, { status: next });
        order.status = next;
        order.items = await manager.findBy(OrderItem, { orderId: id });
        return { order, previous };
      },
    );
    this.events.publish(Number(order.id), { status: order.status, previous });
    return toOrderDto(order);
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
