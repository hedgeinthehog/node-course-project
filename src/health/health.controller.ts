import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/decorators';
import { DataSource } from 'typeorm';

@Controller('health')
@Public()
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  @Get()
  async check() {
    try {
      await this.dataSource.query('SELECT 1');
    } catch (err) {
      throw new ServiceUnavailableException(
        `database unavailable: ${(err as Error).message}`,
      );
    }
    return { status: 'ok', db: 'ok', uptime: Math.floor(process.uptime()) };
  }
}
