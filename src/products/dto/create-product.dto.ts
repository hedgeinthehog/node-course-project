export interface CreateProductDto {
  seller_id: number;
  name: string;
  price_cents: number;
  stock?: number;
}
