import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { IdempotencyStore } from '../common/idempotency';
import { buildPage, decodeCursor, Page } from '../common/pagination';
import { Product } from '../entities/product.entity';
import { User } from '../entities/user.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductDto, toProductDto } from './dto/product.dto';

@Injectable()
export class ProductsService {
  private readonly idempotency = new IdempotencyStore<ProductDto>();

  constructor(
    @InjectRepository(Product)
    private readonly products: Repository<Product>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  create(key: string, dto: CreateProductDto) {
    return this.idempotency.run(key, dto, async () => {
      const sellerId = String(dto.seller_id);
      if (!(await this.users.existsBy({ id: sellerId }))) {
        throw new NotFoundException(`Seller ${dto.seller_id} not found`);
      }
      const product = await this.products.save(
        this.products.create({
          sellerId,
          name: dto.name,
          description: '',
          priceCents: dto.price_cents,
          stock: dto.stock ?? 0,
        }),
      );
      return toProductDto(product);
    });
  }

  async findAll(limit: number, cursor?: string): Promise<Page<ProductDto>> {
    const rows = await this.products.find({
      where: { id: MoreThan(String(decodeCursor(cursor))) },
      order: { id: 'ASC' },
      take: limit + 1,
    });
    return buildPage(rows.map(toProductDto), limit);
  }

  async findOne(id: string): Promise<ProductDto> {
    const product = await this.products.findOneBy({ id });
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return toProductDto(product);
  }
}
