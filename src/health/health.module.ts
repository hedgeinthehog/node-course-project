import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { Lifecycle } from './lifecycle';
import { ProbesController } from './probes.controller';

@Module({
  controllers: [HealthController, ProbesController],
  providers: [Lifecycle],
  exports: [Lifecycle],
})
export class HealthModule {}
