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
import { ProductsService } from './products.service';
import type { CreateProductDto } from './dto/create-product.dto';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  create(
    @Headers('idempotency-key') key: string,
    @Body() dto: CreateProductDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { result, replayed } = this.productsService.create(key, dto);
    if (replayed) {
      res.setHeader('Idempotency-Replay', 'true');
    }
    return result;
  }

  @Get()
  findAll(@Query('limit') limit = 20, @Query('cursor') cursor?: string) {
    return this.productsService.findAll(Number(limit), cursor);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.productsService.findOne(Number(id));
  }
}
