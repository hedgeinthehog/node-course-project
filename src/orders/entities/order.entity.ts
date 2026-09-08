export interface OrderItem {
  product_id: number;
  quantity: number;
}

export interface Order {
  id: number;
  items: OrderItem[];
  total_cents: number;
  status: 'pending' | 'paid' | 'cancelled';
  created_at: string;
}
