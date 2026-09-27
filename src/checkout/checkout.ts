import { DataSource } from 'typeorm';
import { OrderItem } from '../entities/order-item.entity';
import { Order } from '../entities/order.entity';
import { Product } from '../entities/product.entity';
import { Task } from '../entities/task.entity';
import { User } from '../entities/user.entity';

export type CheckoutFailure =
  | 'USER_NOT_FOUND'
  | 'PRODUCT_NOT_FOUND'
  | 'INSUFFICIENT_STOCK'
  | 'INSUFFICIENT_FUNDS';

export class CheckoutError extends Error {
  constructor(
    readonly code: CheckoutFailure,
    message: string,
  ) {
    super(message);
    this.name = 'CheckoutError';
  }
}

export interface CheckoutInput {
  userId: string;
  items: { productId: string; quantity: number }[];
}

export function checkout(
  dataSource: DataSource,
  input: CheckoutInput,
): Promise<Order> {
  return dataSource.transaction(async (manager) => {
    const quantities = new Map<string, number>();
    for (const item of input.items) {
      quantities.set(
        item.productId,
        (quantities.get(item.productId) ?? 0) + item.quantity,
      );
    }

    const lines: Pick<
      OrderItem,
      'productId' | 'quantity' | 'unitPriceCents'
    >[] = [];
    for (const [productId, quantity] of [...quantities].sort(
      ([a], [b]) => Number(a) - Number(b),
    )) {
      const [reserved]: [{ price_cents: number }[], number] =
        await manager.query(
          `UPDATE products SET stock = stock - $2
         WHERE id = $1 AND stock >= $2
         RETURNING price_cents`,
          [productId, quantity],
        );
      if (reserved.length === 0) {
        throw (await manager.existsBy(Product, { id: productId }))
          ? new CheckoutError(
              'INSUFFICIENT_STOCK',
              `Product ${productId}: not enough stock for ${quantity} unit(s)`,
            )
          : new CheckoutError(
              'PRODUCT_NOT_FOUND',
              `Product ${productId} not found`,
            );
      }
      lines.push({
        productId,
        quantity,
        unitPriceCents: reserved[0].price_cents,
      });
    }

    const totalCents = lines.reduce(
      (sum, line) => sum + line.quantity * line.unitPriceCents,
      0,
    );
    const [charged]: [{ id: string }[], number] = await manager.query(
      `UPDATE users SET balance_cents = balance_cents - $2
       WHERE id = $1 AND balance_cents >= $2
       RETURNING id`,
      [input.userId, totalCents],
    );
    if (charged.length === 0) {
      throw (await manager.existsBy(User, { id: input.userId }))
        ? new CheckoutError(
            'INSUFFICIENT_FUNDS',
            `User ${input.userId}: balance does not cover ${totalCents} cents`,
          )
        : new CheckoutError('USER_NOT_FOUND', `User ${input.userId} not found`);
    }

    const order = await manager.save(
      manager.create(Order, {
        userId: input.userId,
        status: 'paid',
        totalCents: String(totalCents),
      }),
    );
    order.items = await manager.save(
      lines.map((line) =>
        manager.create(OrderItem, { orderId: order.id, ...line }),
      ),
    );
    await manager.save(
      manager.create(Task, {
        type: 'order_confirmation',
        payload: { order_id: Number(order.id) },
      }),
    );
    return order;
  });
}
