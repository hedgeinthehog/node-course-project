import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderEvent } from '../entities/order-event.entity';
import { Order } from '../entities/order.entity';
import { EventsModule } from '../events/events.module';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderEventsService } from './order-events.service';
import { OrdersGateway } from './orders.gateway';
import { OrderOwnerGuard } from './order-owner.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Order, OrderEvent]), EventsModule],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrderEventsService,
    OrdersGateway,
    OrderOwnerGuard,
  ],
})
export class OrdersModule {}
