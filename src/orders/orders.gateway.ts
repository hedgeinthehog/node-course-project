import { OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Subscription } from 'rxjs';
import { Server, Socket } from 'socket.io';
import { Repository } from 'typeorm';
import { Order } from '../entities/order.entity';
import { OrderEventsService } from './order-events.service';

export const orderRoom = (orderId: number | string) => `orders:${orderId}`;

interface JoinAck {
  ok: boolean;
  room?: string;
  error?: string;
}

@WebSocketGateway({ cors: { origin: '*' } })
export class OrdersGateway implements OnGatewayInit, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  private subscription?: Subscription;

  constructor(
    private readonly events: OrderEventsService,
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
  ) {}

  afterInit() {
    this.subscription = this.events.all().subscribe((event) => {
      this.server.to(orderRoom(event.orderId)).emit('order.status', event);
    });
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe();
  }

  @SubscribeMessage('join')
  async join(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { orderId?: number | string } | undefined,
  ): Promise<JoinAck> {
    const userId = client.handshake.auth?.userId;
    if (userId === undefined || userId === null || userId === '') {
      return { ok: false, error: 'unauthenticated' };
    }
    const orderId = String(body?.orderId ?? '');
    if (!/^\d+$/.test(orderId)) {
      return { ok: false, error: 'invalid order id' };
    }
    const order = await this.orders.findOneBy({ id: orderId });
    if (!order || order.userId !== String(userId)) {
      return { ok: false, error: 'forbidden' };
    }
    await client.join(orderRoom(orderId));
    return { ok: true, room: orderRoom(orderId) };
  }
}
