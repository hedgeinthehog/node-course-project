import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { OrdersService } from './orders.service';
import type { CreateOrderDto } from './dto/create-order.dto';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  create(
    @Headers('idempotency-key') key: string,
    @Body() dto: CreateOrderDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { result, replayed } = this.ordersService.create(key, dto);
    if (replayed) {
      res.setHeader('Idempotency-Replay', 'true');
    }
    return result;
  }

  @Get()
  findAll(@Query('limit') limit = 20, @Query('cursor') cursor?: string) {
    return this.ordersService.findAll(Number(limit), cursor);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ordersService.findOne(Number(id));
  }
}
