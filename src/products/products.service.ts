import { Injectable, NotFoundException } from '@nestjs/common';
import { IdempotencyStore } from '../common/idempotency';
import { Page, paginate } from '../common/pagination';
import { CreateProductDto } from './dto/create-product.dto';
import { Product } from './entities/product.entity';

@Injectable()
export class ProductsService {
  private readonly products: Product[] = [
    { id: 1, name: 'Keyboard', price_cents: 259900 },
    { id: 2, name: 'Mouse', price_cents: 89900 },
    { id: 3, name: 'Monitor', price_cents: 1249900 },
  ];
  private nextId = 4;
  private readonly idempotency = new IdempotencyStore<Product>();

  create(key: string, dto: CreateProductDto) {
    return this.idempotency.run(key, dto, () => {
      const product: Product = { id: this.nextId++, ...dto };
      this.products.push(product);
      return product;
    });
  }

  findAll(limit: number, cursor?: string): Page<Product> {
    return paginate(this.products, limit, cursor);
  }

  findOne(id: number): Product {
    const product = this.products.find((p) => p.id === id);
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return product;
  }
}
