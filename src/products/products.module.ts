import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from '../entities/product.entity';
import { User } from '../entities/user.entity';
import { RedisModule } from '../redis/redis.module';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Product, User]), RedisModule],
  controllers: [ProductsController],
  providers: [ProductsService],
})
export class ProductsModule {}
