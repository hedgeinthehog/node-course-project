import { Product } from '../../entities/product.entity';

export interface ProductDto {
  id: number;
  name: string;
  price_cents: number;
}

export function toProductDto(product: Product): ProductDto {
  return {
    id: Number(product.id),
    name: product.name,
    price_cents: product.priceCents,
  };
}
