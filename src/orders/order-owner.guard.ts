import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { WsException } from '@nestjs/websockets';
import type { Request } from 'express';
import type { Socket } from 'socket.io';
import { Repository } from 'typeorm';
import { Order } from '../entities/order.entity';

export const USER_ID_HEADER = 'x-user-id';

interface Principal {
  userId: string | null;
  orderId: string;
}

@Injectable()
export class OrderOwnerGuard implements CanActivate {
  constructor(
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { userId, orderId } = this.identify(context);
    if (userId === null) {
      this.refuse(context, new UnauthorizedException('unauthenticated'));
    }
    if (!/^\d+$/.test(orderId)) {
      this.refuse(context, new NotFoundException('invalid order id'));
    }
    const order = await this.orders.findOneBy({ id: orderId });
    if (!order) {
      this.refuse(context, new NotFoundException(`Order ${orderId} not found`));
    }
    if (order.userId !== userId) {
      this.refuse(context, new ForbiddenException('forbidden'));
    }
    return true;
  }

  private identify(context: ExecutionContext): Principal {
    if (context.getType() === 'ws') {
      const client = context.switchToWs().getClient<Socket>();
      const body = context.switchToWs().getData<{ orderId?: unknown }>();
      return {
        userId: normalize(client.handshake.auth?.userId),
        orderId: String(body?.orderId ?? ''),
      };
    }
    const request = context.switchToHttp().getRequest<Request>();
    return {
      userId: normalize(request.header(USER_ID_HEADER)),
      orderId: String(request.params.id ?? ''),
    };
  }

  private refuse(context: ExecutionContext, error: HttpException): never {
    if (context.getType() === 'ws') {
      throw new WsException({ ok: false, error: error.message });
    }
    throw error;
  }
}

function normalize(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return /^\d+$/.test(text) ? text : null;
}
