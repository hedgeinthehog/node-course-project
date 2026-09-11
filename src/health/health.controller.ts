import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  async check() {
    try {
      await this.pool.query('SELECT 1');
    } catch (err) {
      throw new ServiceUnavailableException(
        `database unavailable: ${(err as Error).message}`,
      );
    }
    return { status: 'ok', db: 'ok', uptime: Math.floor(process.uptime()) };
  }
}
