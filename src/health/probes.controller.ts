import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Public } from '../auth/decorators';
import { Lifecycle } from './lifecycle';

@Controller()
@Public()
export class ProbesController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly lifecycle: Lifecycle,
  ) {}

  @Get('healthz')
  live() {
    return { status: 'ok' };
  }

  @Get('readyz')
  async ready() {
    if (this.lifecycle.isDraining) {
      throw new ServiceUnavailableException('draining before shutdown');
    }
    try {
      await this.dataSource.query('SELECT 1');
    } catch (err) {
      throw new ServiceUnavailableException(
        `database unavailable: ${(err as Error).message}`,
      );
    }
    return { status: 'ready' };
  }
}
