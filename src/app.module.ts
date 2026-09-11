import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { validate } from './config/env.schema';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';
import { HealthModule } from './health/health.module';
import { ProblemFilter } from './common/problem.filter';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate }),
    ProductsModule,
    OrdersModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
export class AppModule {}
