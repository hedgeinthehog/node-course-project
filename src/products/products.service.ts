import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, MoreThan, Repository } from 'typeorm';
import type { Principal } from '../auth/auth.service';
import { IdempotencyStore } from '../common/idempotency';
import { buildPage, decodeCursor, Page } from '../common/pagination';
import { Product } from '../entities/product.entity';
import { User } from '../entities/user.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { CacheAside } from '../redis/cache-aside';
import { ProductDto, toProductDto } from './dto/product.dto';
import {
  loadProductCard,
  PRODUCT_CARD_TTL,
  ProductCardDto,
  productCardKey,
} from './product-card';

@Injectable()
export class ProductsService {
  private readonly idempotency: IdempotencyStore;

  constructor(
    @InjectRepository(Product)
    private readonly products: Repository<Product>,
    private readonly dataSource: DataSource,
    private readonly cache: CacheAside,
  ) {
    this.idempotency = new IdempotencyStore(dataSource);
  }

  create(key: string, dto: CreateProductDto, actor: Principal) {
    if (actor.role !== 'admin' && String(dto.seller_id) !== actor.id) {
      throw new ForbiddenException(
        `seller ${actor.id} cannot create products for seller ${dto.seller_id}`,
      );
    }
    return this.idempotency.run(key, dto, async (manager) => {
      const sellerId = String(dto.seller_id);
      if (!(await manager.existsBy(User, { id: sellerId }))) {
        throw new NotFoundException(`Seller ${dto.seller_id} not found`);
      }
      const product = await manager.save(
        manager.create(Product, {
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

  async findOne(id: string): Promise<ProductCardDto> {
    const card = await this.cache.getOrLoad(
      productCardKey(id),
      () => loadProductCard(this.dataSource, id),
      PRODUCT_CARD_TTL,
    );
    if (!card) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return card;
  }
}
