const RETRYABLE_SQLSTATE = new Set(['40001', '40P01']);

export function retryableCode(err: unknown): string | null {
  const candidate = err as { code?: unknown; driverError?: { code?: unknown } };
  const code = candidate?.code ?? candidate?.driverError?.code;
  return typeof code === 'string' && RETRYABLE_SQLSTATE.has(code) ? code : null;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, code: string, delayMs: number) => void;
}

export async function withRetry<T>(
  run: () => Promise<T>,
  { maxAttempts = 10, baseDelayMs = 10, onRetry }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const code = retryableCode(err);
      if (!code || attempt >= maxAttempts) throw err;
      const delayMs = Math.round(
        baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random()),
      );
      onRetry?.(attempt, code, delayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
