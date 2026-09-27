export interface CreateOrderItemDto {
  product_id: number;
  quantity: number;
}

export interface CreateOrderDto {
  user_id: number;
  items: CreateOrderItemDto[];
}
