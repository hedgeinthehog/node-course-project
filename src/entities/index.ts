import { IdempotencyKey } from './idempotency-key.entity';
import { OrderEvent } from './order-event.entity';
import { OrderItem } from './order-item.entity';
import { Order } from './order.entity';
import { OutboxEvent } from './outbox-event.entity';
import { ProcessedMessage } from './processed-message.entity';
import { Product } from './product.entity';
import { Shipment } from './shipment.entity';
import { Task } from './task.entity';
import { User } from './user.entity';

export const entities = [
  User,
  Product,
  Order,
  OrderItem,
  Task,
  OrderEvent,
  Shipment,
  OutboxEvent,
  ProcessedMessage,
  IdempotencyKey,
];
