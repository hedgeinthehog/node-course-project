import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, MoreThan, Repository } from 'typeorm';
import type { Principal } from '../auth/auth.service';
import { CheckoutError } from '../checkout/checkout';
import { buildPage, decodeCursor, Page } from '../common/pagination';
import { OrderItem } from '../entities/order-item.entity';
import { Order } from '../entities/order.entity';
import { productCardKey } from '../products/product-card';
import { CacheAside } from '../redis/cache-aside';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderDto, toOrderDto } from './dto/order.dto';
import { OrderEventsService } from './order-events.service';
import { canTransition, OrderStatus } from './order-status';
import { placeOrder } from './place-order';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    private readonly dataSource: DataSource,
    private readonly events: OrderEventsService,
    private readonly cache: CacheAside,
  ) {}

  async create(key: string, dto: CreateOrderDto, actor: Principal) {
    if (actor.role !== 'admin' && String(dto.user_id) !== actor.id) {
      throw new ForbiddenException(
        `user ${actor.id} cannot place an order for user ${dto.user_id}`,
      );
    }
    try {
      const outcome = await placeOrder(this.dataSource, key, dto);
      if (!outcome.replayed) {
        await this.cache.invalidate(
          ...outcome.result.items.map((item) =>
            productCardKey(item.product_id),
          ),
        );
      }
      return outcome;
    } catch (err) {
      if (err instanceof CheckoutError) {
        throw err.code === 'USER_NOT_FOUND' || err.code === 'PRODUCT_NOT_FOUND'
          ? new NotFoundException(err.message)
          : new ConflictException(err.message);
      }
      throw err;
    }
  }

  async findAll(
    limit: number,
    cursor: string | undefined,
    actor: Principal,
  ): Promise<Page<OrderDto>> {
    const rows = await this.orders.find({
      where: {
        id: MoreThan(String(decodeCursor(cursor))),
        ...(actor.role !== 'admin' && { userId: actor.id }),
      },
      order: { id: 'ASC' },
      take: limit + 1,
      relations: { items: true },
    });
    return buildPage(rows.map(toOrderDto), limit);
  }

  async changeStatus(id: string, next: OrderStatus): Promise<OrderDto> {
    const { order, event } = await this.dataSource.transaction(
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
        const event = await this.events.record(manager, id, {
          status: next,
          previous,
        });
        return { order, event };
      },
    );
    this.events.publish(event);
    return toOrderDto(order);
  }

  async findOne(id: string, actor: Principal): Promise<OrderDto> {
    const order = await this.orders.findOne({
      where: { id },
      relations: { items: true },
    });
    if (!order) {
      throw new NotFoundException(`Order ${id} not found`);
    }
    if (actor.role !== 'admin' && order.userId !== actor.id) {
      throw new ForbiddenException(`Order ${id} belongs to another user`);
    }
    return toOrderDto(order);
  }
}
