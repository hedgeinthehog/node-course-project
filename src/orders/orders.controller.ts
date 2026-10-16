import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { OrdersService } from './orders.service';
import type { CreateOrderDto } from './dto/create-order.dto';
import type { ChangeOrderStatusDto } from './dto/change-order-status.dto';
import { OrderEventsService } from './order-events.service';
import { OrderOwnerGuard } from './order-owner.guard';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly events: OrderEventsService,
  ) {}

  @Post()
  async create(
    @Headers('idempotency-key') key: string,
    @Body() dto: CreateOrderDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { result, replayed } = await this.ordersService.create(key, dto);
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
    return this.ordersService.findOne(id);
  }

  @Patch(':id/status')
  changeStatus(@Param('id') id: string, @Body() dto: ChangeOrderStatusDto) {
    return this.ordersService.changeStatus(id, dto.status);
  }

  @Get(':id/events')
  @UseGuards(OrderOwnerGuard)
  streamEvents(
    @Param('id') id: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Res() res: Response,
  ) {
    const afterId = Number(lastEventId) || 0;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1000\n\n');

    const subscription = this.events
      .stream(Number(id), afterId)
      .subscribe((event) => {
        res.write(
          `event: order.status\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    res.on('close', () => {
      clearInterval(heartbeat);
      subscription.unsubscribe();
      res.end();
    });
  }
}
