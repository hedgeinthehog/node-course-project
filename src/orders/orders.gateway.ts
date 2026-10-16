import { OnModuleDestroy, UseGuards } from '@nestjs/common';
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
import { OrderEventsService } from './order-events.service';
import { OrderOwnerGuard } from './order-owner.guard';

export const orderRoom = (orderId: number | string) => `orders:${orderId}`;

@WebSocketGateway({ cors: { origin: '*' } })
export class OrdersGateway implements OnGatewayInit, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  private subscription?: Subscription;

  constructor(private readonly events: OrderEventsService) {}

  afterInit() {
    this.subscription = this.events.all().subscribe((event) => {
      this.server.to(orderRoom(event.orderId)).emit('order.status', event);
    });
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe();
  }

  @UseGuards(OrderOwnerGuard)
  @SubscribeMessage('join')
  async join(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { orderId: number | string },
  ) {
    const room = orderRoom(body.orderId);
    await client.join(room);
    return { ok: true, room };
  }
}
