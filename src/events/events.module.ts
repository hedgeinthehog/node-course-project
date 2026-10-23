import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Env } from '../config/env.schema';
import { EventPublisher } from './publisher';
import { OutboxRelay } from './relay';

@Module({
  providers: [
    {
      provide: EventPublisher,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new EventPublisher(
          config.get('BROKER_URL', { infer: true }),
          (message) => new Logger(EventPublisher.name).error(message),
        ),
    },
    {
      provide: OutboxRelay,
      inject: [DataSource, EventPublisher],
      useFactory: (dataSource: DataSource, publisher: EventPublisher) =>
        new OutboxRelay(dataSource, publisher, {
          onError: (message) => new Logger(OutboxRelay.name).error(message),
        }),
    },
  ],
  exports: [EventPublisher, OutboxRelay],
})
export class EventsModule {}
