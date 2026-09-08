import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';
import { ProblemFilter } from './common/problem.filter';

@Module({
  imports: [ProductsModule, OrdersModule],
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
export class AppModule {}
