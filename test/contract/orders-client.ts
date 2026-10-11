export interface OrderItemDto {
  product_id: number;
  quantity: number;
}

export interface OrderDto {
  id: number;
  user_id: number;
  items: OrderItemDto[];
  total_cents: number;
  status: 'pending' | 'paid' | 'cancelled';
  created_at: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
}

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail);
    this.name = 'ApiError';
  }
}

export class OrdersClient {
  constructor(private readonly baseUrl: string) {}

  getOrder(id: number): Promise<OrderDto> {
    return this.send(`/orders/${id}`, {
      headers: { Accept: 'application/json' },
    });
  }

  placeOrder(
    idempotencyKey: string,
    order: { user_id: number; items: OrderItemDto[] },
  ): Promise<OrderDto> {
    return this.send('/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(order),
    });
  }

  private async send(path: string, init: RequestInit): Promise<OrderDto> {
    const response = await fetch(`${this.baseUrl}${path}`, init);
    const body = await response.json();
    if (!response.ok) throw new ApiError(body as Problem);
    return body as OrderDto;
  }
}
