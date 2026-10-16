import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.schema';
import { EventPublisher } from './publisher';

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
  ],
  exports: [EventPublisher],
})
export class EventsModule {}
