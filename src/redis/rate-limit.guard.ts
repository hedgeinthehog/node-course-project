import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RateLimiter } from './rate-limiter';

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(private readonly limiter: RateLimiter) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (request.path === '/health') return true;
    const response = context.switchToHttp().getResponse<Response>();
    const client = `ip:${request.ip}`;

    let verdict;
    try {
      verdict = await this.limiter.hit(client);
    } catch (err) {
      this.logger.error(
        `rate limit unavailable, letting the request through: ${(err as Error).message}`,
      );
      return true;
    }
    response.setHeader('RateLimit-Limit', this.limiter.options.limit);
    response.setHeader('RateLimit-Remaining', verdict.remaining);
    if (verdict.allowed) return true;
    response.setHeader(
      'Retry-After',
      Math.max(1, Math.ceil(verdict.retryAfterMs / 1000)),
    );
    throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
  }
}
