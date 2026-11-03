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
import type { Socket } from 'socket.io';
import { Repository } from 'typeorm';
import { AuthService, Principal } from '../auth/auth.service';
import { AuthenticatedRequest } from '../auth/decorators';
import { Order } from '../entities/order.entity';

@Injectable()
export class OrderOwnerGuard implements CanActivate {
  constructor(
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user, orderId } = await this.identify(context);
    if (!user) {
      this.refuse(context, new UnauthorizedException('unauthenticated'));
    }
    if (!/^\d+$/.test(orderId)) {
      this.refuse(context, new NotFoundException('invalid order id'));
    }
    const order = await this.orders.findOneBy({ id: orderId });
    if (!order) {
      this.refuse(context, new NotFoundException(`Order ${orderId} not found`));
    }
    if (user.role !== 'admin' && order.userId !== user.id) {
      this.refuse(context, new ForbiddenException('forbidden'));
    }
    return true;
  }

  private async identify(
    context: ExecutionContext,
  ): Promise<{ user: Principal | null; orderId: string }> {
    if (context.getType() === 'ws') {
      const client = context.switchToWs().getClient<Socket>();
      const body = context.switchToWs().getData<{ orderId?: unknown }>();
      const token = client.handshake.auth?.token;
      let user: Principal | null = null;
      if (typeof token === 'string') {
        user = await this.auth.authenticate(token).catch(() => null);
      }
      return { user, orderId: String(body?.orderId ?? '') };
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return {
      user: request.user ?? null,
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
